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

/** CLI seam: copy the example into place without overwriting. */
export function initScreenerBank(): { created: boolean; path: string } {
  const { bankPath, examplePath } = screenerBankPaths();
  if (fs.existsSync(bankPath)) return { created: false, path: bankPath };
  fs.mkdirSync(path.dirname(bankPath), { recursive: true });
  fs.copyFileSync(examplePath, bankPath);
  return { created: true, path: bankPath };
}
