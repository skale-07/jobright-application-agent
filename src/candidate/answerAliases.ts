import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getConfig } from "../config/index.js";

const AliasesSchema = z.record(z.string(), z.array(z.string()));

export type AnswerAliases = Record<string, string[]>;

export function loadAnswerAliases(filePath?: string): AnswerAliases {
  const cfg = getConfig();
  const candidate = filePath
    ? path.resolve(filePath)
    : path.join(cfg.privateDir, "candidate", "answer-aliases.json");
  const example = path.join(
    cfg.privateDir,
    "candidate",
    "answer-aliases.example.json",
  );

  const target = fs.existsSync(candidate) ? candidate : example;
  if (!fs.existsSync(target)) {
    return {};
  }
  const raw = JSON.parse(fs.readFileSync(target, "utf8")) as unknown;
  return AliasesSchema.parse(raw);
}
