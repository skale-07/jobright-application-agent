/**
 * Gmail safety boundary. The Gmail client exists for exactly one purpose:
 * reading verification codes / magic links during navigation. Send, modify,
 * and compose must never exist in this repo — the identifiers below are
 * enforced by scripts/check-forbidden.ts (same discipline as the Outlook
 * send guards), and the client pins + asserts the readonly scope.
 */

export class GmailWriteForbiddenError extends Error {
  constructor(message = "Gmail write access is forbidden. Readonly only.") {
    super(message);
    this.name = "GmailWriteForbiddenError";
  }
}

/** The ONLY scope this repo may request or accept. */
export const GMAIL_READONLY_SCOPE =
  "https://www.googleapis.com/auth/gmail.readonly";

/** Patterns that must not appear in production source (see check-forbidden). */
export const FORBIDDEN_GMAIL_IDENTIFIERS = [
  ["users", "messages", "send"].join("."),
  ["gmail", "users", "messages", "send"].join("."),
  ["auth/gmail", "send"].join("."),
  ["auth/gmail", "modify"].join("."),
  ["auth/gmail", "compose"].join("."),
  ["GMAIL", "SEND", "ENABLED"].join("_"),
] as const;
