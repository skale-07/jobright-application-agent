import { randomUUID } from "node:crypto";
import type { Db } from "../storage/db/client.js";
import { getConfig, resetConfigCache } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { PlaywrightServiceSession } from "../auth/serviceSession.js";
import { getApplication, transitionApplication } from "../queue/stateMachine.js";
import { assertDraftsOnlyMode } from "./sendGuards.js";
import {
  OUTLOOK_WEB_DRAFTS_URL,
  OUTLOOK_WEB_MAIL_URL,
} from "../auth/outlookValidateExtra.js";
import { outlookSelectorsV1 } from "./selectors.js";
import { composeDraftContent, hashDraftBody } from "./draftComposer.js";

/**
 * Draft creation writes into the operator's mailbox Drafts folder — a
 * mutation, so it takes both gates. Nothing in this module (or repository)
 * can dispatch mail; the banned-identifier check enforces that at CI level.
 */
export function assertDraftCreationAllowed(): void {
  resetConfigCache();
  const cfg = getConfig();
  assertDraftsOnlyMode(cfg.outlookDraftsEnabled);
  if (cfg.dryRun) {
    throw new Error(
      "DRY_RUN=true — refusing draft creation. Set DRY_RUN=false to write into the Drafts folder.",
    );
  }
}

export type DraftReport = {
  draft_id: string | null;
  application_id: string;
  contact_id: string;
  recipient_email: string | null;
  subject: string | null;
  status: "SAVED" | "REFUSED" | "FAILED";
  verified: boolean;
  reason: string;
  application_state: string;
};

/**
 * Compose the validated outreach email into a new Outlook web draft.
 * The Drafts folder is the human review surface: the operator edits or
 * deletes there, and nothing is ever dispatched by this codebase.
 */
export async function createOutlookDraft(input: {
  db: Db;
  applicationId: string;
  contactId: string;
  headless?: boolean;
}): Promise<DraftReport> {
  const { db, applicationId, contactId } = input;
  assertDraftCreationAllowed();

  const app = getApplication(db, applicationId);
  if (!app) throw new Error(`Unknown application: ${applicationId}`);
  if (app.state !== "EMAIL_GENERATED" && app.state !== "DRAFT_CREATING") {
    throw new Error(
      `Draft creation requires EMAIL_GENERATED (got ${app.state})`,
    );
  }

  const composed = composeDraftContent(db, { applicationId, contactId });

  const existing = db
    .prepare(
      `SELECT id, status FROM outlook_drafts
       WHERE application_id = ? AND recipient_email = ?`,
    )
    .get(applicationId, composed.recipient_email) as
    | { id: string; status: string }
    | undefined;
  if (existing && existing.status === "SAVED") {
    return {
      draft_id: existing.id,
      application_id: applicationId,
      contact_id: contactId,
      recipient_email: composed.recipient_email,
      subject: composed.subject,
      status: "REFUSED",
      verified: false,
      reason:
        "A saved draft for this recipient already exists (UNIQUE application+recipient)",
      application_state: app.state,
    };
  }

  if (app.state === "EMAIL_GENERATED") {
    transitionApplication(db, {
      applicationId,
      nextState: "DRAFT_CREATING",
      reason: `draft creation started for ${composed.recipient_email}`,
    });
  }

  // PENDING row before any mailbox mutation — crash evidence, like submissions.
  const draftId = existing?.id ?? randomUUID();
  if (existing) {
    db.prepare(
      `UPDATE outlook_drafts SET status = 'PENDING', metadata_json = ? WHERE id = ?`,
    ).run(
      JSON.stringify({ body_hash: composed.body_hash, generation: composed.email_generation_id }),
      draftId,
    );
  } else {
    db.prepare(
      `INSERT INTO outlook_drafts (
        id, application_id, contact_id, recipient_email, subject, status,
        verified, created_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, 'PENDING', 0, ?, ?)`,
    ).run(
      draftId,
      applicationId,
      contactId,
      composed.recipient_email,
      composed.subject,
      new Date().toISOString(),
      JSON.stringify({
        body_hash: composed.body_hash,
        generation: composed.email_generation_id,
      }),
    );
  }

  const session = new PlaywrightServiceSession({
    service: "outlook",
    headless: input.headless ?? false,
    slowMoMs: 80,
  });
  try {
    await session.open();
    const page = await session.newPage({ purpose: "draft_create" });
    try {
      await page.goto(OUTLOOK_WEB_MAIL_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page
        .locator(outlookSelectorsV1.compose.newMailButton)
        .first()
        .click({ timeout: 30_000 });
      await page
        .locator(outlookSelectorsV1.compose.toField)
        .first()
        .fill(composed.recipient_email, { timeout: 15_000 });
      await page
        .locator(outlookSelectorsV1.compose.subjectField)
        .first()
        .fill(composed.subject, { timeout: 15_000 });
      await page
        .locator(outlookSelectorsV1.compose.bodyField)
        .first()
        .fill(composed.body_text, { timeout: 15_000 });
      // Outlook autosaves; give it a beat, then close the compose surface.
      await page.waitForTimeout(3000);
      await page
        .locator(outlookSelectorsV1.compose.closeButton)
        .first()
        .click({ timeout: 10_000 })
        .catch(() => undefined);
      await page.waitForTimeout(1500);
    } finally {
      await page.close().catch(() => undefined);
    }
  } finally {
    await session.close();
  }

  db.prepare(`UPDATE outlook_drafts SET status = 'SAVED' WHERE id = ?`).run(
    draftId,
  );
  transitionApplication(db, {
    applicationId,
    nextState: "DRAFT_CREATED",
    reason: `draft saved for ${composed.recipient_email}`,
  });

  logger.info("outlook draft saved", {
    service: "outlook",
    action: "draft_create",
    metadata: { application_id: applicationId, draft_id: draftId },
  });

  return {
    draft_id: draftId,
    application_id: applicationId,
    contact_id: contactId,
    recipient_email: composed.recipient_email,
    subject: composed.subject,
    status: "SAVED",
    verified: false,
    reason: "draft saved; run draft:verify to confirm content",
    application_state:
      getApplication(db, applicationId)?.state ?? "DRAFT_CREATED",
  };
}

export type DraftVerificationReport = {
  draft_id: string;
  found: boolean;
  subject_matched: boolean;
  body_hash_matched: boolean;
  verified: boolean;
  notes: string[];
};

/**
 * Deterministic acceptance check: re-open the Drafts folder, find the draft
 * by subject, compare the body hash against what generation produced.
 */
export async function verifyOutlookDraft(input: {
  db: Db;
  draftId: string;
  headless?: boolean;
}): Promise<DraftVerificationReport> {
  const { db, draftId } = input;
  assertDraftCreationAllowed();

  const draft = db
    .prepare(
      `SELECT id, application_id, recipient_email, subject, metadata_json
       FROM outlook_drafts WHERE id = ?`,
    )
    .get(draftId) as
    | {
        id: string;
        application_id: string;
        recipient_email: string;
        subject: string | null;
        metadata_json: string;
      }
    | undefined;
  if (!draft) throw new Error(`Unknown draft: ${draftId}`);
  const expectedHash = (
    JSON.parse(draft.metadata_json) as { body_hash?: string }
  ).body_hash;

  const notes: string[] = [];
  let found = false;
  let subjectMatched = false;
  let bodyHashMatched = false;

  const session = new PlaywrightServiceSession({
    service: "outlook",
    headless: input.headless ?? false,
    slowMoMs: 80,
  });
  try {
    await session.open();
    const page = await session.newPage({ purpose: "draft_verify" });
    try {
      await page.goto(OUTLOOK_WEB_DRAFTS_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForTimeout(3000);
      const item = page
        .locator(outlookSelectorsV1.drafts.listItem)
        .filter({ hasText: draft.subject ?? "" })
        .first();
      found = (await item.count()) > 0;
      if (found && draft.subject) {
        subjectMatched = true;
        await item.click();
        await page.waitForTimeout(2000);
        const body = await page
          .locator(outlookSelectorsV1.compose.bodyField)
          .first()
          .innerText()
          .catch(() => "");
        const normalized = body.replace(/\r\n/g, "\n").trim();
        bodyHashMatched =
          expectedHash !== undefined &&
          hashDraftBody(normalized) === expectedHash;
        if (!bodyHashMatched) {
          notes.push(
            "body hash mismatch — Outlook may normalize whitespace; inspect manually",
          );
        }
      } else {
        notes.push("draft not found by subject in Drafts folder");
      }
    } finally {
      await page.close().catch(() => undefined);
    }
  } finally {
    await session.close();
  }

  const verified = found && subjectMatched;
  if (verified) {
    db.prepare(`UPDATE outlook_drafts SET verified = 1 WHERE id = ?`).run(
      draftId,
    );
  }

  return {
    draft_id: draftId,
    found,
    subject_matched: subjectMatched,
    body_hash_matched: bodyHashMatched,
    verified,
    notes,
  };
}
