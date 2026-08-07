import { createHash } from "node:crypto";
import type { Db } from "../storage/db/client.js";

export type ComposedDraft = {
  email_generation_id: string;
  contact_id: string;
  recipient_email: string;
  subject: string;
  body_text: string;
  /** sha256 of body_text — stored in outlook_drafts.metadata_json (the table has no body column) and re-checked by verifyOutlookDraft. */
  body_hash: string;
};

export function hashDraftBody(bodyText: string): string {
  return createHash("sha256").update(bodyText, "utf8").digest("hex");
}

/**
 * Pure composition from a VALIDATED email_generations row. REJECTED or
 * missing generations never become drafts; a contact without an email
 * address cannot be drafted to.
 */
export function composeDraftContent(
  db: Db,
  input: { applicationId: string; contactId: string },
): ComposedDraft {
  const generation = db
    .prepare(
      `SELECT id, subject, body_text, validation_status
       FROM email_generations
       WHERE application_id = ? AND contact_id = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(input.applicationId, input.contactId) as
    | {
        id: string;
        subject: string | null;
        body_text: string | null;
        validation_status: string;
      }
    | undefined;

  if (!generation) {
    throw new Error(
      `No email generation for contact ${input.contactId} — run email:generate first`,
    );
  }
  if (generation.validation_status !== "VALIDATED") {
    throw new Error(
      `Latest generation for contact ${input.contactId} is ${generation.validation_status} — only VALIDATED emails become drafts`,
    );
  }
  if (!generation.subject || !generation.body_text) {
    throw new Error(
      `Generation ${generation.id} is missing subject or body`,
    );
  }

  const contact = db
    .prepare(`SELECT email FROM contacts WHERE id = ?`)
    .get(input.contactId) as { email: string | null } | undefined;
  if (!contact?.email) {
    throw new Error(
      `Contact ${input.contactId} has no email address — cannot create a draft`,
    );
  }

  return {
    email_generation_id: generation.id,
    contact_id: input.contactId,
    recipient_email: contact.email,
    subject: generation.subject,
    body_text: generation.body_text,
    body_hash: hashDraftBody(generation.body_text),
  };
}
