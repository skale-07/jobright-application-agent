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
  // Tool-slug shapes. An integration layer (Composio and friends) reaches
  // mail by NAME, so `execute("GMAIL_SEND_EMAIL")` is a send call that
  // contains none of the API-shaped strings above — it passed this check
  // clean until 2026-08-12. The slugs ship in the same toolkit as the
  // draft ones, one identifier apart.
  ["GMAIL", "SEND", "EMAIL"].join("_"),
  ["GMAIL", "SEND", "DRAFT"].join("_"),
  ["GMAIL", "REPLY", "TO", "THREAD"].join("_"),
] as const;
