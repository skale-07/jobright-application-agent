import { createHash, randomUUID } from "node:crypto";
import type { Page } from "playwright";
import type { Db } from "../storage/db/client.js";
import { getConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { PlaywrightServiceSession } from "../auth/serviceSession.js";
import { cdpReachable } from "../verification/gmailWebProvider.js";
import { getContact } from "../contacts/repository.js";

/**
 * Gmail DRAFTS tail (operator directive 2026-08-18): after triage +
 * template generation, each VALIDATED email lands as a draft in the
 * operator's own Gmail — never sent.
 *
 * The invariant mirrors the Outlook tail: the ONLY controls this module
 * clicks are Compose, the To/Subject/Body fields, and "Save & close".
 * Gmail persists the draft on close. The Send control exists in the
 * selector registry solely as a named FORBIDDEN entry so tests can assert
 * it is never a click target — same pattern as insider triage's
 * "Start Email".
 */
export const GMAIL_DRAFT_SELECTOR_REGISTRY_VERSION = "gmail-drafts-v1";

export const gmailDraftSelectorsV1 = {
  validation: "UNVERIFIED" as const,
  url: "https://mail.google.com/",
  /** The Compose button ([gh=cm] is Gmail's stable hook; text fallback). */
  compose: '[gh="cm"], [role="button"][aria-label*="Compose" i]',
  composeText: /^compose$/i,
  /** Compose dialog fields. */
  to: 'input[aria-label*="To recipients" i], textarea[name="to"], input[peoplekit-id], div[aria-label*="Search Field" i] input',
  subject: 'input[name="subjectbox"]',
  body: 'div[aria-label*="Message Body" i][contenteditable="true"], div[role="textbox"][contenteditable="true"]',
  /** Closing the compose window saves the draft. */
  saveAndClose: '[aria-label*="Save & close" i], [alt="Close" i], img.Ha',
  /**
   * FORBIDDEN control — never a click target. Present so the guard is
   * data, not prose, and so a test can prove no send ever fires.
   */
  sendButton: '[aria-label*="Send" i][role="button"], [data-tooltip*="Send" i]',
  /** Drafts search that verification reads back. */
  draftsSearchUrl: (to: string): string =>
    `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(`in:draft to:${to}`)}`,
} as const;

export type GmailDraftFields = {
  to: string;
  subject: string;
  body: string;
};

/**
 * Drive an already-open Gmail(-shaped) page to a saved draft. Pure page
 * choreography — no flags, no DB — so fixtures can prove the click
 * discipline. Returns what it actually did.
 */
export async function draftEmailOnGmailPage(
  page: Page,
  fields: GmailDraftFields,
): Promise<{ composed: boolean; notes: string[] }> {
  const notes: string[] = [];
  const s = gmailDraftSelectorsV1;
  let compose = page.locator(s.compose).first();
  if ((await compose.count().catch(() => 0)) === 0) {
    compose = page
      .locator('button, [role="button"]')
      .filter({ hasText: s.composeText })
      .first();
  }
  if ((await compose.count().catch(() => 0)) === 0) {
    notes.push("compose button not found");
    return { composed: false, notes };
  }
  await compose.click({ timeout: 5_000 });

  const to = page.locator(s.to).first();
  await to.waitFor({ state: "visible", timeout: 10_000 });
  await to.fill(fields.to);
  // Commit the chip — Gmail turns the address into a token on Enter.
  await to.press("Enter").catch(() => undefined);

  await page.locator(s.subject).first().fill(fields.subject);
  const body = page.locator(s.body).first();
  await body.click({ timeout: 5_000 });
  await body.fill(fields.body);

  // Save & close persists the draft. NEVER the send button.
  await page.locator(s.saveAndClose).first().click({ timeout: 5_000 });
  notes.push("draft composed and closed (Gmail autosaves on close)");
  return { composed: true, notes };
}

/** Read-back: the draft exists iff Drafts search shows the subject. */
export async function verifyDraftOnGmailPage(
  page: Page,
  fields: { to: string; subject: string },
): Promise<boolean> {
  await page
    .goto(gmailDraftSelectorsV1.draftsSearchUrl(fields.to), {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    })
    .catch(() => undefined);
  await page.waitForTimeout(1_500);
  const hit = page.getByText(fields.subject, { exact: false }).first();
  return (await hit.count().catch(() => 0)) > 0;
}

export type GmailDraftResult = {
  gmail_draft_id: string;
  recipient_email: string;
  subject: string;
  status: "DRAFTED" | "FAILED";
  verified: boolean;
  notes: string[];
};

/**
 * Live orchestrator: take the VALIDATED generated email for one contact,
 * open the operator's signed-in session (CDP debug Chrome preferred, the
 * saved jobright storage state otherwise — same preference as the Gmail
 * mailbox scanner), compose the draft, verify by read-back, record the
 * row. Gated by GMAIL_DRAFTS_ENABLED; refuses a contact without a
 * VALIDATED generation or an email address.
 */
export async function createGmailDraft(input: {
  db: Db;
  applicationId: string;
  contactId: string;
  headless?: boolean;
}): Promise<GmailDraftResult> {
  const cfg = getConfig();
  if (!cfg.gmailDraftsEnabled) {
    throw new Error(
      "GMAIL_DRAFTS_ENABLED=false — refusing Gmail draft creation (mailbox mutation).",
    );
  }
  const contact = getContact(input.db, input.contactId);
  if (!contact || contact.application_id !== input.applicationId) {
    throw new Error(`Contact ${input.contactId} not found on this application`);
  }
  if (!contact.email) {
    throw new Error(
      `Contact ${input.contactId} has no email — run contacts:insider first`,
    );
  }
  const generation = input.db
    .prepare(
      `SELECT subject, body_text FROM email_generations
       WHERE application_id = ? AND contact_id = ? AND validation_status = 'VALIDATED'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(input.applicationId, input.contactId) as
    | { subject: string; body_text: string }
    | undefined;
  if (!generation) {
    throw new Error(
      "no VALIDATED generated email for this contact — run email:generate first",
    );
  }

  const existing = input.db
    .prepare(
      `SELECT id, status, verified FROM gmail_drafts
       WHERE application_id = ? AND recipient_email = ?`,
    )
    .get(input.applicationId, contact.email) as
    | { id: string; status: string; verified: number }
    | undefined;
  if (existing && existing.status === "DRAFTED" && existing.verified === 1) {
    return {
      gmail_draft_id: existing.id,
      recipient_email: contact.email,
      subject: generation.subject,
      status: "DRAFTED",
      verified: true,
      notes: ["draft already exists and verified — not recreating"],
    };
  }

  const useCdp = await cdpReachable(cfg.agentCdpUrl);
  const session = new PlaywrightServiceSession({
    service: "jobright",
    ...(useCdp ? { mode: "CDP_ATTACH" as const } : {}),
    headless: useCdp ? true : (input.headless ?? true),
  });
  const notes: string[] = [];
  let composed = false;
  let verified = false;
  await session.open();
  try {
    const page = await session.newPage({ purpose: "gmail_draft" });
    try {
      await page.goto(gmailDraftSelectorsV1.url, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForTimeout(2_000);
      const result = await draftEmailOnGmailPage(page, {
        to: contact.email,
        subject: generation.subject,
        body: generation.body_text,
      });
      composed = result.composed;
      notes.push(...result.notes);
      if (composed) {
        verified = await verifyDraftOnGmailPage(page, {
          to: contact.email,
          subject: generation.subject,
        });
        notes.push(
          verified
            ? "draft verified by Drafts read-back"
            : "draft NOT verifiable by read-back — check Gmail Drafts manually",
        );
      }
    } finally {
      await page.close().catch(() => undefined);
    }
  } finally {
    await session.close();
  }

  const status: "DRAFTED" | "FAILED" = composed ? "DRAFTED" : "FAILED";
  const bodySha = createHash("sha256")
    .update(generation.body_text)
    .digest("hex");
  const id = existing?.id ?? randomUUID();
  if (existing) {
    input.db
      .prepare(
        `UPDATE gmail_drafts SET status = ?, verified = ?, subject = ?, metadata_json = ? WHERE id = ?`,
      )
      .run(
        status,
        verified ? 1 : 0,
        generation.subject,
        JSON.stringify({ body_sha256: bodySha, notes }),
        id,
      );
  } else {
    input.db
      .prepare(
        `INSERT INTO gmail_drafts (
          id, application_id, contact_id, recipient_email, subject, status,
          verified, created_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.applicationId,
        input.contactId,
        contact.email,
        generation.subject,
        status,
        verified ? 1 : 0,
        new Date().toISOString(),
        JSON.stringify({ body_sha256: bodySha, notes }),
      );
  }
  logger.info("gmail draft run finished", {
    service: "outreach",
    action: "gmail_draft",
    metadata: {
      application_id: input.applicationId,
      contact_id: input.contactId,
      status,
      verified,
    },
  });
  return {
    gmail_draft_id: id,
    recipient_email: contact.email,
    subject: generation.subject,
    status,
    verified,
    notes,
  };
}
