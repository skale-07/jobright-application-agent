#!/usr/bin/env node
/**
 * Phase 5 verification gate (Windows-friendly).
 *
 * Ordinary steps run fail-closed:
 *   FORM_FILL_ENABLED=false DRY_RUN=true SUBMIT_ENABLED=false
 *
 * Only the final local Greenhouse fixture fill receives:
 *   FORM_FILL_ENABLED=true DRY_RUN=false SUBMIT_ENABLED=false
 *
 * Does not mutate this process's process.env — each child gets an isolated env object.
 * This gate is UNIT_CONFIRMED + FIXTURE_CONFIRMED only. Live JobRight/Greenhouse remain UNVERIFIED.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verifyDb = path.join(root, "data", "verify-phase5.sqlite");
const verifyArtifacts = path.join(root, "artifacts", "verify-phase5");

const SAFE_FLAGS = {
  FORM_FILL_ENABLED: "false",
  DRY_RUN: "true",
  SUBMIT_ENABLED: "false",
} as const;

const FIXTURE_EXECUTE_FLAGS = {
  FORM_FILL_ENABLED: "true",
  DRY_RUN: "false",
  SUBMIT_ENABLED: "false",
} as const;

function childEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  // Isolated object — do not mutate global process.env
  return {
    ...process.env,
    ...SAFE_FLAGS,
    ...overrides,
  };
}

function run(
  label: string,
  command: string,
  args: string[],
  envOverrides: Record<string, string> = {},
): void {
  console.log(`\n==> ${label}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: childEnv(envOverrides),
    stdio: "inherit",
    shell: true,
  });
  if (result.status !== 0) {
    console.error(`verify:phase5 failed at: ${label}`);
    process.exit(result.status ?? 1);
  }
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

for (const p of [verifyDb, `${verifyDb}-wal`, `${verifyDb}-shm`]) {
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
fs.mkdirSync(path.dirname(verifyDb), { recursive: true });
fs.mkdirSync(verifyArtifacts, { recursive: true });

const verifyPaths = {
  DATABASE_PATH: verifyDb,
  ARTIFACTS_DIR: verifyArtifacts,
};

run("typecheck", npm, ["run", "typecheck"]);
run("test", npm, ["run", "test"], { ...verifyPaths });
run("migrate", npm, ["run", "migrate"], { ...verifyPaths });
run("check:forbidden", npm, ["run", "check:forbidden"]);
run("check:secrets", npm, ["run", "check:secrets"]);
run(
  "controlled greenhouse fixture execution (FIXTURE_CONFIRMED)",
  npm,
  ["run", "ats:fill", "--", "--fixture", "greenhouse", "--execute"],
  {
    ...verifyPaths,
    ...FIXTURE_EXECUTE_FLAGS,
  },
);

console.log(`
verify:phase5: ok

UNIT_CONFIRMED
- Environment isolation (safe flags forced for typecheck/test/migrate/checks)
- Fill guard / submit guard fail-closed defaults
- Application deduplication, sponsorship review routing, redaction, idempotency (via test suite)

FIXTURE_CONFIRMED
- Local Greenhouse fixture deterministic fill (--fixture greenhouse --execute)
- Local synthetic resume upload path (when exercised by suite)
- Local JobRight-style PDF download orchestration (suite)

UNVERIFIED
- Live JobRight resume generation and download
- Live Greenhouse form filling
- Live Greenhouse employer-side upload completion
- Mid-run authentication loss across every live path
- Multi-process stress beyond current SQLite locking tests
`);
