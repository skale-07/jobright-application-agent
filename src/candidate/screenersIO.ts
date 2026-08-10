import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config/index.js";
import {
  parseScreenerBank,
  type ScreenerAnswerBank,
} from "./screeners.js";

export function screenerBankPaths(): {
  bankPath: string;
  examplePath: string;
} {
  const cfg = getConfig();
  return {
    bankPath: path.join(cfg.privateDir, "candidate", "screeners.json"),
    examplePath: path.join(cfg.privateDir, "candidate", "screeners.example.json"),
  };
}

/**
 * Absent bank = feature quietly off (null), matching how the rest of the
 * pipeline treats optional operator materials. A PRESENT but invalid bank
 * throws — a half-parsed answer file must never half-fill forms.
 */
export function tryLoadScreenerBank(filePath?: string): ScreenerAnswerBank | null {
  const { bankPath } = screenerBankPaths();
  const target = filePath ? path.resolve(filePath) : bankPath;
  if (!fs.existsSync(target)) return null;
  const raw = JSON.parse(fs.readFileSync(target, "utf8")) as unknown;
  return parseScreenerBank(raw);
}

/**
 * Promote an approved prediction into the bank's custom section. Called
 * ONLY by the review promote resolver — this is the single write path by
 * which a model-proposed answer becomes fillable, and it runs after the
 * human clicked approve. Merges labels when the key already exists.
 */
export function addCustomScreenerAnswer(input: {
  key: string;
  answer: string;
  label: string;
}): { path: string; key: string } {
  const { bankPath } = screenerBankPaths();
  const existing = tryLoadScreenerBank();
  const bank: ScreenerAnswerBank =
    existing ?? { version: 1, answers: {}, custom: {} };
  const prior = bank.custom[input.key];
  bank.custom[input.key] = {
    answer: input.answer,
    labels: [...new Set([...(prior?.labels ?? []), input.label])],
    promoted_at: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(bankPath), { recursive: true });
  fs.writeFileSync(bankPath, `${JSON.stringify(bank, null, 2)}\n`, "utf8");
  return { path: bankPath, key: input.key };
}

/** CLI seam: copy the example into place without overwriting. */
export function initScreenerBank(): { created: boolean; path: string } {
  const { bankPath, examplePath } = screenerBankPaths();
  if (fs.existsSync(bankPath)) return { created: false, path: bankPath };
  fs.mkdirSync(path.dirname(bankPath), { recursive: true });
  fs.copyFileSync(examplePath, bankPath);
  return { created: true, path: bankPath };
}
