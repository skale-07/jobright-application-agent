#!/usr/bin/env node
/**
 * Rejects presence of sensitive artifact filenames in the working tree
 * that should never be committed. Used as a Phase 1 security check.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const FORBIDDEN_NAME_PATTERNS = [
  /\.storage\.json$/i,
  /sensitive-profile\.json$/i,
  /sensitive-profile\.enc$/i,
  /cookies\.json$/i,
  /resume\.pdf$/i,
  /cover-letter\.pdf$/i,
  /submission-receipt\.json$/i,
];

function listTrackedOrStaged(): string[] {
  try {
    const out = execSync("git ls-files -c -o --exclude-standard", {
      cwd: root,
      encoding: "utf8",
    });
    return out.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

let failed = false;
for (const file of listTrackedOrStaged()) {
  const base = path.basename(file);
  // Allow committed examples only
  if (file.includes(".example.")) continue;
  if (file.startsWith("private/") && !file.includes(".example.")) {
    // private/ itself is gitignored; if it appears in ls-files something is wrong
    console.error(`Sensitive path should not be tracked: ${file}`);
    failed = true;
  }
  for (const re of FORBIDDEN_NAME_PATTERNS) {
    if (re.test(base) || re.test(file)) {
      console.error(`Forbidden artifact pattern matched: ${file}`);
      failed = true;
    }
  }
}

// Also ensure .gitignore contains critical entries
const gi = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
for (const required of ["private/", "data/", "artifacts/", "*.storage.json", "*.enc"]) {
  if (!gi.includes(required)) {
    console.error(`.gitignore missing required entry: ${required}`);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}

console.log("check-secrets: ok");
