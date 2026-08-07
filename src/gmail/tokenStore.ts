import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getConfig } from "../config/index.js";
import { GMAIL_READONLY_SCOPE } from "./readonlyGuards.js";

/**
 * Refresh-token storage for the readonly Gmail client. Lives under
 * private/ (gitignored + pre-commit-enforced), written 0600. Gmail is
 * API-only — deliberately NOT a ServiceName / browser session. The stored
 * grant records its scope, and the schema only admits the readonly scope —
 * a token file claiming anything wider fails to parse at all.
 */
const tokenFileSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  refresh_token: z.string().min(1),
  account_email: z.string().email(),
  scope: z.literal(GMAIL_READONLY_SCOPE),
  obtained_at: z.string(),
});

export type GmailTokenFile = z.infer<typeof tokenFileSchema>;

export function gmailTokenPath(): string {
  return path.join(getConfig().privateDir, "auth", "gmail.oauth.json");
}

export function readGmailToken(): GmailTokenFile | null {
  const p = gmailTokenPath();
  if (!fs.existsSync(p)) return null;
  return tokenFileSchema.parse(JSON.parse(fs.readFileSync(p, "utf8")));
}

export function writeGmailToken(token: GmailTokenFile): string {
  const p = gmailTokenPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(tokenFileSchema.parse(token), null, 2), {
    mode: 0o600,
  });
  return p;
}
