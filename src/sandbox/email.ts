import { randomInt } from "node:crypto";

/**
 * The sandbox employer's outbound mail — verification codes only.
 *
 * Operator directive 2026-08-16: "I want to use the resend API so I can
 * test out the system in its entirety through the verification …
 * basically has to go through my emails, my most recent emails, and be
 * able to determine what the actual code is by opening the email."
 *
 * This is the EMPLOYER side of the test rig: the fake company emails a
 * one-time code to the operator's own inbox, exactly like Workday/Paycom
 * tenants do, so the real recovery path (portal auth detects the code
 * wall → the Gmail web scanner opens the newest matching email → the code
 * is typed back) can be rehearsed end to end against mail that actually
 * exists.
 *
 * Boundaries, deliberately narrow:
 *   - Verification codes only. No free-form body, no attachments, no
 *     outreach — the subject and body are fixed templates around a
 *     6-digit code. The drafts-only outreach invariant (sendGuards) is
 *     about mail TO employers/contacts; this is the fake employer mailing
 *     the OPERATOR, and it still cannot say anything but a code.
 *   - Requires RESEND_API_KEY *and* a recipient the operator configured
 *     (SANDBOX_VERIFY_TO, falling back to PORTAL_LOGIN_EMAIL — the same
 *     address the system signs up with, which is where a real tenant's
 *     code would land). Missing either ⇒ nothing is sent; the code prints
 *     to the sandbox console so the wall stays manually testable.
 *   - Fail-open: a Resend error becomes a console line, never a crash.
 */

export type CodeDelivery = {
  sent: boolean;
  /** Where the code went: "resend:<to>" or "console". */
  channel: string;
  note: string;
};

/** Six digits, leading zeros allowed — the shape every real tenant uses. */
export function generateVerificationCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";
/** Resend's shared onboarding sender works without domain verification. */
const DEFAULT_FROM = "Frobnicator Sandbox <onboarding@resend.dev>";

export async function deliverVerificationCode(input: {
  code: string;
  accountEmail: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}): Promise<CodeDelivery> {
  const env = input.env ?? process.env;
  const apiKey = env["RESEND_API_KEY"]?.trim();
  const to = (env["SANDBOX_VERIFY_TO"] ?? env["PORTAL_LOGIN_EMAIL"])?.trim();
  if (!apiKey || !to) {
    return {
      sent: false,
      channel: "console",
      note: `no ${!apiKey ? "RESEND_API_KEY" : "SANDBOX_VERIFY_TO/PORTAL_LOGIN_EMAIL"} — code shown in the sandbox terminal only`,
    };
  }
  const from = env["SANDBOX_VERIFY_FROM"]?.trim() || DEFAULT_FROM;
  try {
    const res = await (input.fetchImpl ?? fetch)(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: "Your Frobnicator Industries verification code",
        // The phrasing matters: the mailbox scanner keys on real tenants'
        // language ("verification code", "enter the code"), so the sandbox
        // mail must read like the mail it stands in for.
        html: `<p>Thanks for creating your Frobnicator Industries account (${input.accountEmail}).</p>
<p>Your verification code is: <strong>${input.code}</strong></p>
<p>Enter the code to continue your application. It expires when the sandbox restarts.</p>`,
        text: `Your Frobnicator Industries verification code is ${input.code}. Enter the code to continue your application.`,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        sent: false,
        channel: "console",
        note: `resend refused (${res.status}): ${body.slice(0, 120)} — code shown in the sandbox terminal`,
      };
    }
    return { sent: true, channel: `resend:${to}`, note: `verification code emailed to ${to}` };
  } catch (err) {
    return {
      sent: false,
      channel: "console",
      note: `resend unreachable (${err instanceof Error ? err.message.slice(0, 80) : String(err)}) — code shown in the sandbox terminal`,
    };
  }
}
