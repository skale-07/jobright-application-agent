#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FORBIDDEN_OUTLOOK_IDENTIFIERS } from "../src/outlook/sendGuards.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  "data",
  "artifacts",
  "cache",
  "private",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx|js|mjs|cjs|md)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const allowlist = new Set([
  path.join(root, "src", "outlook", "sendGuards.ts"),
  path.join(root, "scripts", "check-forbidden.ts"),
  path.join(root, "tests", "unit", "outlook-send-guards.test.ts"),
  path.join(root, "docs", "security.md"),
  path.join(root, "docs", "architecture.md"),
]);

let failed = false;
const files = walk(root);

for (const file of files) {
  if (allowlist.has(file)) continue;
  const text = fs.readFileSync(file, "utf8");
  for (const pattern of FORBIDDEN_OUTLOOK_IDENTIFIERS) {
    if (text.includes(pattern)) {
      console.error(`FORBIDDEN pattern "${pattern}" in ${path.relative(root, file)}`);
      failed = true;
    }
  }
}

if (failed) {
  process.exit(1);
}

console.log("check-forbidden: ok");
