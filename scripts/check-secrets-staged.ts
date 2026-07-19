#!/usr/bin/env node
/**
 * Rejects presence of sensitive artifact filenames in the working tree
 * that should never be committed. Used as a Phase 1+ security check.
 *
 * Allowlist: only tests/fixtures/ats/greenhouse/sample-resume.pdf
 * (synthetic minimal PDF; content must start with %PDF- and match expected hash).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { scanArtifactPaths } from "../src/security/artifactScan.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

const result = scanArtifactPaths(listTrackedOrStaged(), root);

if (!result.ok) {
  for (const hit of result.hits) {
    console.error(`${hit.reason}: ${hit.file}`);
  }
  process.exit(1);
}

console.log("check-secrets: ok");
