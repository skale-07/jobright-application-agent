import type { GmailClient } from "./client.js";
import { extractMagicLink, extractOtpCode } from "./verificationParsers.js";

export type VerificationWaitResult =
  | { kind: "code"; code: string; messageId: string; pollsUsed: number }
  | { kind: "link"; url: string; messageId: string; pollsUsed: number }
  | { kind: "timeout"; pollsUsed: number };

/**
 * Bounded poll for the verification email the nav agent reported. Query is
 * scoped hard: only messages after the request timestamp, to the mailbox
 * the site claimed, optionally from the hinted sender. Codes/links are
 * parsed deterministically; the artifact layer records message ids only.
 */
export async function waitForVerificationEmail(input: {
  client: GmailClient;
  need: {
    sent_to: string;
    sender_hint?: string | undefined;
    subject_hint?: string | undefined;
    requested_at: string;
  };
  /** Employer-domain allowlist for magic links (sender domain always counts). */
  extraAllowedDomains?: string[];
  polls?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<VerificationWaitResult> {
  const polls = Math.min(input.polls ?? 10, 10);
  const intervalMs = input.intervalMs ?? 6_000;
  const sleep =
    input.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const afterEpoch = Math.floor(
    new Date(input.need.requested_at).getTime() / 1000,
  );
  const parts = [`after:${Number.isFinite(afterEpoch) ? afterEpoch : 0}`];
  if (/^[^@\s]+@[^@\s]+$/.test(input.need.sent_to)) {
    parts.push(`to:${input.need.sent_to}`);
  }
  if (input.need.sender_hint && /^[^\s]+$/.test(input.need.sender_hint)) {
    parts.push(`from:${input.need.sender_hint}`);
  }
  const query = parts.join(" ");

  for (let poll = 1; poll <= polls; poll++) {
    const summaries = await input.client.searchMessages(query, {
      maxResults: 5,
    });
    for (const summary of summaries) {
      const message = await input.client.getMessage(summary.id);
      const code = extractOtpCode(message.subject, message.bodyText);
      if (code) {
        return { kind: "code", code, messageId: message.id, pollsUsed: poll };
      }
      const link = extractMagicLink(message.bodyText, {
        senderAddress: message.from.replace(/^.*<([^>]+)>.*$/, "$1"),
        ...(input.extraAllowedDomains
          ? { extraAllowedDomains: input.extraAllowedDomains }
          : {}),
      });
      if (link) {
        return { kind: "link", url: link, messageId: message.id, pollsUsed: poll };
      }
    }
    if (poll < polls) await sleep(intervalMs);
  }
  return { kind: "timeout", pollsUsed: polls };
}
