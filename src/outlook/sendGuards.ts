/**
 * Outlook safety boundary (Phase 1).
 * Draft creation/verification arrive in Phase 12.
 * There must never be a production sendEmail / sendMail API.
 */

export class OutlookSendForbiddenError extends Error {
  constructor(message = "Outlook send is forbidden. Drafts only.") {
    super(message);
    this.name = "OutlookSendForbiddenError";
  }
}

export async function createDraft(_args: unknown): Promise<never> {
  throw new Error("createDraft is not implemented until Phase 12");
}

export async function verifyDraft(_args: unknown): Promise<never> {
  throw new Error("verifyDraft is not implemented until Phase 12");
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
