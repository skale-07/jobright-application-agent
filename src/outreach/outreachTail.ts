import type { Db } from "../storage/db/client.js";
import { getConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { getApplication } from "../queue/stateMachine.js";
import { upsertOpenReviewItem } from "../queue/reviewItems.js";
import { listContacts } from "../contacts/repository.js";
import { rankOutreachContacts } from "../contacts/rank.js";
import { generateEmailForContact } from "../contacts/emailGenerate.js";
import {
  hasLlmKey,
  makeLlmClient,
  type EmailLlmClient,
} from "../contacts/emailLlm.js";
import {
  createOutlookDraft,
  verifyOutlookDraft,
  type DraftReport,
  type DraftVerificationReport,
} from "../outlook/draftRun.js";

/**
 * The isolated outreach subsystem — the post-submit referral tail as one
 * unit: pick the best contact → generate the email (LLM, deterministically
 * re-validated) → create the Outlook DRAFT → verify it by read-back.
 * Extracted from the automation worker so "emailing" stands alone from
 * "applying" and "verification", with its own seams and tests.
 *
 * Trust boundaries (unchanged): drafts only, never send — the only mailbox
 * mutation is createOutlookDraft, itself behind OUTLOOK_DRAFTS_ENABLED +
 * DRY_RUN and the sendGuards/check-forbidden bans. Every failure lands as
 * a review item + note; a submission is never reversed by outreach.
 */

export type DraftRunner = (input: {
  db: Db;
  applicationId: string;
  contactId: string;
  headless?: boolean;
}) => Promise<DraftReport>;

export type DraftVerifier = (input: {
  db: Db;
  draftId: string;
  headless?: boolean;
}) => Promise<DraftVerificationReport>;

export type OutreachTailResult = {
  application_id: string;
  email_status: "generated" | "rejected" | "skipped" | null;
  draft_status: "verified" | "saved" | "refused" | "failed" | "skipped" | null;
  notes: string[];
};

/** End states the outreach tail can pick up from. */
export const OUTREACH_TAIL_STATES = new Set([
  "CONTACTS_EXTRACTED",
  "EMAIL_GENERATED",
]);

/**
 * The M6 tail: after a verified submit the pipeline dead-ends at
 * CONTACTS_EXTRACTED / EMAIL_GENERATED (stop:"gate") — this picks those up
 * when the env carries the outreach flags. Fail-open into named notes.
 */
export async function runOutreachTail(input: {
  db: Db;
  applicationId: string;
  headless?: boolean;
  emailClient?: EmailLlmClient;
  draftRunner?: DraftRunner;
  draftVerifier?: DraftVerifier;
}): Promise<OutreachTailResult> {
  const { db, applicationId } = input;
  const result: OutreachTailResult = {
    application_id: applicationId,
    email_status: null,
    draft_status: null,
    notes: [],
  };
  const cfg = getConfig();

  try {
    // Phase 1 — outreach generation (spend surface; generateEmailForContact
    // re-asserts the gate itself). REJECTED already opened a review item.
    if (getApplication(db, applicationId)?.state === "CONTACTS_EXTRACTED") {
      if (!cfg.emailGenerationEnabled || !hasLlmKey(cfg)) {
        result.email_status = "skipped";
        result.notes.push("email generation gated off");
        return result;
      }
      const jobRole =
        (
          db
            .prepare(
              `SELECT j.role AS role FROM jobs j
               JOIN applications a ON a.job_id = j.id WHERE a.id = ?`,
            )
            .get(applicationId) as { role: string | null } | undefined
        )?.role ?? null;
      const contact = rankOutreachContacts(
        listContacts(db, applicationId),
        jobRole,
      )[0];
      if (!contact) {
        result.email_status = "skipped";
        result.notes.push("no contact with both name and email");
        return result;
      }
      const gen = await generateEmailForContact({
        db,
        applicationId,
        contactId: contact.id,
        client: input.emailClient ?? makeLlmClient(),
      });
      if (gen.validation_status !== "VALIDATED") {
        result.email_status = "rejected";
        result.notes.push("generation rejected — review item opened");
        return result;
      }
      result.email_status = "generated";
    }

    // Phase 2 — Outlook draft (mailbox mutation; createOutlookDraft
    // re-asserts drafts-only + DRY_RUN). Verify by deterministic read-back.
    if (getApplication(db, applicationId)?.state === "EMAIL_GENERATED") {
      if (!cfg.outlookDraftsEnabled || cfg.dryRun) {
        result.draft_status = "skipped";
        result.notes.push("draft creation gated off");
        return result;
      }
      const gen = db
        .prepare(
          `SELECT contact_id FROM email_generations
           WHERE application_id = ? AND validation_status = 'VALIDATED'
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(applicationId) as { contact_id: string } | undefined;
      if (!gen) {
        result.draft_status = "skipped";
        result.notes.push("no VALIDATED generation to draft from");
        return result;
      }
      const create = input.draftRunner ?? createOutlookDraft;
      const draft = await create({
        db,
        applicationId,
        contactId: gen.contact_id,
        headless: input.headless ?? true,
      });
      if (draft.status !== "SAVED" || !draft.draft_id) {
        result.draft_status = draft.status === "REFUSED" ? "refused" : "failed";
        result.notes.push(`draft ${draft.status}: ${draft.reason}`);
        if (draft.status === "FAILED") {
          upsertOpenReviewItem(db, {
            applicationId,
            kind: "MANUAL",
            title: "Outreach draft failed after submit",
            payload: { reason: draft.reason },
          });
        }
        return result;
      }
      const verify = input.draftVerifier ?? verifyOutlookDraft;
      const v = await verify({
        db,
        draftId: draft.draft_id,
        headless: input.headless ?? true,
      });
      result.draft_status = v.verified ? "verified" : "saved";
      if (!v.verified) result.notes.push(`draft saved but unverified: ${v.notes.join("; ")}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.notes.push(`outreach tail error: ${message.slice(0, 200)}`);
    upsertOpenReviewItem(db, {
      applicationId,
      kind: "MANUAL",
      title: "Outreach tail failed after submit",
      payload: { error: message.slice(0, 500) },
    });
    logger.warn("outreach tail failed — submission unaffected", {
      service: "outreach",
      action: "outreach_tail_error",
      metadata: { application_id: applicationId },
    });
  }
  return result;
}
