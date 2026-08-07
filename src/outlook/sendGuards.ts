/**
 * Outlook safety boundary.
 * Real draft creation/verification live in draftRun.ts (draft vocabulary
 * only). There must never be a production send-style API in this repo;
 * FORBIDDEN_OUTLOOK_IDENTIFIERS is enforced by scripts/check-forbidden.ts.
 */

export class OutlookSendForbiddenError extends Error {
  constructor(message = "Outlook send is forbidden. Drafts only.") {
    super(message);
    this.name = "OutlookSendForbiddenError";
  }
}

/** Patterns that must not appear in production source (enforced by scripts/check-forbidden.ts). */
export const FORBIDDEN_OUTLOOK_IDENTIFIERS = [
  ["EMAIL", "SEND", "ENABLED"].join("_"),
  "function sendEmail",
  "async function sendEmail",
  "const sendEmail",
  "export async function sendEmail",
  "export function sendEmail",
  "sendMail(",
] as const;

export function assertDraftsOnlyMode(outlookDraftsEnabled: boolean): void {
  if (!outlookDraftsEnabled) {
    throw new OutlookSendForbiddenError(
      "OUTLOOK_DRAFTS_ENABLED is false — draft creation blocked",
    );
  }
}
