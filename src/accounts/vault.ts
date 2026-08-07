import { createHash, randomInt } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getConfig } from "../config/index.js";

/**
 * ATS account vault: credentials the nav agent creates or reuses when an
 * employer forces an account. Files live under private/ats-accounts/
 * (gitignored + pre-commit-enforced), written 0600, keyed by a host hash
 * so filenames leak nothing. Credentials NEVER enter SQLite, artifacts, or
 * logs — they ride only the in-memory navigate task into the sidecar's
 * stdin, and redactNavigationTask strips them before anything persists.
 */
const accountSchema = z.object({
  host: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
  created_at: z.string(),
  created_by_run_id: z.string(),
  notes: z.array(z.string()).default([]),
});

export type AtsAccount = z.infer<typeof accountSchema>;

export function hostHash(host: string): string {
  return createHash("sha256").update(host.toLowerCase()).digest("hex").slice(0, 16);
}

function accountPath(host: string): string {
  return path.join(
    getConfig().privateDir,
    "ats-accounts",
    `${hostHash(host)}.json`,
  );
}

const UPPER = "ABCDEFGHJKMNPQRSTUVWXYZ";
const LOWER = "abcdefghjkmnpqrstuvwxyz";
const DIGIT = "23456789";
const SYMBOL = "!@#$%^&*-_+=";

/** 20 chars, class-guaranteed (≥1 upper/lower/digit/symbol), crypto-random. */
export function generatePassword(): string {
  const all = UPPER + LOWER + DIGIT + SYMBOL;
  const pick = (set: string): string => set[randomInt(set.length)]!;
  const chars = [pick(UPPER), pick(LOWER), pick(DIGIT), pick(SYMBOL)];
  while (chars.length < 20) {
    chars.push(all[randomInt(all.length)]!);
  }
  // Fisher–Yates with crypto randomness so the guaranteed classes aren't positional.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}

export function getAccount(host: string): AtsAccount | null {
  const p = accountPath(host);
  if (!fs.existsSync(p)) return null;
  return accountSchema.parse(JSON.parse(fs.readFileSync(p, "utf8")));
}

export function getOrCreateAccount(
  host: string,
  input: { email: string; runId: string },
): { account: AtsAccount; created: boolean } {
  const existing = getAccount(host);
  if (existing) return { account: existing, created: false };
  const account: AtsAccount = {
    host: host.toLowerCase(),
    username: input.email,
    password: generatePassword(),
    created_at: new Date().toISOString(),
    created_by_run_id: input.runId,
    notes: [],
  };
  const p = accountPath(host);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(account, null, 2), { mode: 0o600 });
  return { account, created: true };
}
