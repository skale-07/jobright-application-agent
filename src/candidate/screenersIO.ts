import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config/index.js";
import {
  parseScreenerBank,
  type ScreenerAnswerBank,
} from "./screeners.js";
import { findCustomScreenerMatch } from "./screenerMatch.js";

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
 * Write a custom bank entry. Used by the review promote resolver and by
 * plan-time predict persist. Merges labels when the key already exists
 * and overwrites the answer — callers that must not clobber should use
 * {@link rememberPredictedScreenerAnswer}.
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

/**
 * Persist a plan-time prediction so the next verbatim question is
 * deterministic. First write wins: if this normalized label is already
 * in the bank, keep the stored answer. A later hallucination must not
 * overwrite a learned pair.
 */
export function rememberPredictedScreenerAnswer(input: {
  key: string;
  answer: string;
  label: string;
}): { path: string; key: string; wrote: boolean } {
  const { bankPath } = screenerBankPaths();
  const existing = tryLoadScreenerBank();
  const hit = existing ? findCustomScreenerMatch(input.label, existing) : null;
  if (hit && existing) {
    const prior = existing.custom[hit.key];
    if (prior) {
      addCustomScreenerAnswer({
        key: hit.key,
        answer: prior.answer,
        label: input.label,
      });
    }
    return { path: bankPath, key: hit.key, wrote: false };
  }
  const saved = addCustomScreenerAnswer(input);
  return { ...saved, wrote: true };
}

/** Record a paraphrase on an existing custom entry so the next hit is exact. */
export function attachCustomScreenerLabel(key: string, label: string): void {
  const existing = tryLoadScreenerBank();
  const prior = existing?.custom[key];
  if (!prior) return;
  addCustomScreenerAnswer({ key, answer: prior.answer, label });
}

/**
 * Drop learned question/answer pairs so the next fill starts fresh.
 * Registry `answers` (how_heard, etc.) stay. Custom entries are the
 * compounding store the predictor writes.
 */
export function forgetCustomScreenerAnswers(): {
  cleared: number;
  keys: string[];
  path: string | null;
} {
  const { bankPath } = screenerBankPaths();
  const existing = tryLoadScreenerBank();
  if (!existing) return { cleared: 0, keys: [], path: null };
  const keys = Object.keys(existing.custom);
  if (keys.length === 0) return { cleared: 0, keys: [], path: bankPath };
  existing.custom = {};
  fs.writeFileSync(bankPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
  return { cleared: keys.length, keys, path: bankPath };
}

/** CLI seam: copy the example into place without overwriting. */
export function initScreenerBank(): { created: boolean; path: string } {
  const { bankPath, examplePath } = screenerBankPaths();
  if (fs.existsSync(bankPath)) return { created: false, path: bankPath };
  fs.mkdirSync(path.dirname(bankPath), { recursive: true });
  fs.copyFileSync(examplePath, bankPath);
  return { created: true, path: bankPath };
}
