import { askLine } from "../util/stdin.js";
import { GMAIL_READONLY_SCOPE, GmailWriteForbiddenError } from "./readonlyGuards.js";
import { writeGmailToken } from "./tokenStore.js";
import type { FetchLike } from "./client.js";

/**
 * One-time operator OAuth flow (Desktop-app client + loopback redirect,
 * paste-the-redirect-URL): Google's device-code flow does not cover Gmail
 * scopes and OOB is deprecated, so the operator opens the consent URL in
 * any browser, lands on a dead localhost URL after consenting, and pastes
 * that full URL back here. The exchanged grant is verified to be readonly
 * before anything is stored (private/auth/gmail.oauth.json, 0600).
 */
const REDIRECT_URI = "http://localhost:8791/cb";

export function buildConsentUrl(clientId: string): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", REDIRECT_URI);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GMAIL_READONLY_SCOPE);
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  return u.href;
}

export function extractCodeFromRedirect(pastedUrl: string): string {
  const u = new URL(pastedUrl.trim());
  const code = u.searchParams.get("code");
  if (!code) throw new Error("Pasted URL carries no ?code= parameter");
  return code;
}

export async function runGmailAuthFlow(input: {
  clientId: string;
  clientSecret: string;
  accountEmail: string;
  fetchImpl?: FetchLike;
  askLineImpl?: (prompt: string) => Promise<string>;
}): Promise<string> {
  const fetchImpl = input.fetchImpl ?? (fetch as unknown as FetchLike);
  const ask = input.askLineImpl ?? askLine;

  console.log("\nOpen this URL in any browser, consent, then paste the full");
  console.log("redirect URL (the localhost page that fails to load):\n");
  console.log(buildConsentUrl(input.clientId));
  const pasted = await ask("\nRedirect URL: ");
  const code = extractCodeFromRedirect(pasted);

  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
    }).toString(),
  });
  if (!res.ok) throw new Error(`Token exchange failed (HTTP ${res.status})`);
  const body = (await res.json()) as {
    refresh_token?: string;
    scope?: string;
  };
  if (!body.refresh_token) {
    throw new Error(
      "No refresh_token in the exchange — remove prior app access at myaccount.google.com/permissions and retry",
    );
  }
  const scopes = (body.scope ?? "").split(/\s+/).filter(Boolean);
  if (scopes.length === 0) {
    throw new GmailWriteForbiddenError(
      "Token exchange returned no scope — cannot verify the grant is readonly; refusing to store.",
    );
  }
  const beyond = scopes.filter((s) => s !== GMAIL_READONLY_SCOPE);
  if (beyond.length > 0) {
    throw new GmailWriteForbiddenError(
      `Granted scopes exceed readonly (${beyond.join(", ")}) — refusing to store the token.`,
    );
  }
  return writeGmailToken({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    refresh_token: body.refresh_token,
    account_email: input.accountEmail,
    scope: GMAIL_READONLY_SCOPE,
    obtained_at: new Date().toISOString(),
  });
}
