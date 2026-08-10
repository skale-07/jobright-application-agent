import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  migrate,
  openDatabase,
  type Db,
} from "../../src/storage/db/client.js";
import { resetConfigCache } from "../../src/config/index.js";
import {
  execOptionsForPlatform,
  runAutoCycle,
} from "../../src/automation/autoCycle.js";
import { getActiveArmSession, getArmStatus } from "../../src/automation/armSession.js";
import {
  applyControlledFillEnv,
  applySafeFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";

/**
 * Hands-off cycle (operator-guide §19): the scheduled task's environment is
 * the standing authorization; the cycle refuses loudly when it is not
 * coherent, never double-arms, and never leaves an arm live past its own
 * run. UNIT_CONFIRMED — worker and git/npm are seams; no browser, no
 * network, no real session.
 */
describe("auto-cycle (UNIT_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");
  let db: Db;
  let dbPath: string;
  const noExec = (cmd: string, args: string[]): string => {
    throw new Error(`unexpected exec in test: ${cmd} ${args.join(" ")}`);
  };

  beforeEach(() => {
    applySafeFillEnv();
    dbPath = path.join(os.tmpdir(), `jaa-autocycle-${randomUUID()}.sqlite`);
    process.env.DATABASE_PATH = dbPath;
    resetConfigCache();
    db = openDatabase(dbPath);
    migrate(db);
  });

  afterEach(() => {
    closeDatabase(db);
    delete process.env.SUBMIT_REQUIRES_LOCAL_CONFIRMATION;
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.rmSync(p, { force: true });
    }
    resetConfigCache();
  });

  const armEnv = (): void => {
    applyControlledFillEnv({
      AUTOMATION_ENABLED: "true",
      FORM_FILL_ENABLED: "true",
      SUBMIT_ENABLED: "true",
      NAVIGATION_ENABLED: "true",
      DRY_RUN: "false",
      SUBMIT_REQUIRES_LOCAL_CONFIRMATION: "false",
    });
  };

  it("refuses with every missing flag NAMED when the environment is not armed", async () => {
    const r = await runAutoCycle(
      { skipUpdate: true },
      { db, exec: noExec, sessionRunner: async () => { throw new Error("must not run"); } },
    );
    expect(r.outcome).toBe("refused");
    const notes = r.preflight.notes.join(" ");
    expect(notes).toMatch(/AUTOMATION_ENABLED/);
    expect(notes).toMatch(/SUBMIT_ENABLED/);
    expect(notes).toMatch(/DRY_RUN=false/);
    // No arm row was ever created.
    expect(getActiveArmSession(db)).toBeFalsy();
  });

  it("refuses when SUBMIT_REQUIRES_LOCAL_CONFIRMATION is still true", async () => {
    armEnv();
    applyControlledFillEnv({ SUBMIT_REQUIRES_LOCAL_CONFIRMATION: "true" });
    const r = await runAutoCycle(
      { skipUpdate: true },
      { db, exec: noExec, sessionRunner: async () => { throw new Error("must not run"); } },
    );
    expect(r.outcome).toBe("refused");
    expect(r.preflight.notes.join(" ")).toMatch(/SUBMIT_REQUIRES_LOCAL_CONFIRMATION/);
  });

  it("arms, runs the worker seam, and ALWAYS disarms afterward", async () => {
    armEnv();
    let seenArmId: string | null = null;
    const r = await runAutoCycle(
      { skipUpdate: true, durationMinutes: 30, maxSubmits: 2, maxApps: 3 },
      {
        db,
        exec: noExec,
        sessionRunner: async (database, armRunId) => {
          seenArmId = armRunId;
          // The arm is LIVE while the worker runs.
          expect(getArmStatus(database).armed).toBe(true);
          return {
            arm_run_id: armRunId,
            apps_started: 1,
            submits_used: 0,
            stopped_reason: "queue_drained",
            discover_runs: 0,
            emails_generated: 0,
            drafts_saved: 0,
            essay_drafts_generated: 0,
            screener_predictions_generated: 0,
            notes: [],
            per_app: [],
          };
        },
      },
    );
    expect(r.outcome).toBe("completed");
    expect(r.arm?.arm_run_id).toBe(seenArmId);
    expect(r.arm?.max_submits).toBe(2);
    expect(r.session?.stopped_reason).toBe("queue_drained");
    // Cycle over ⇒ disarmed, no live arm survives the run.
    expect(getActiveArmSession(db)).toBeFalsy();
  });

  it("a crashing worker still ends disarmed, with the error in notes", async () => {
    armEnv();
    const r = await runAutoCycle(
      { skipUpdate: true },
      {
        db,
        exec: noExec,
        sessionRunner: async () => {
          throw new Error("browser exploded");
        },
      },
    );
    expect(r.outcome).toBe("error");
    expect(r.notes.join(" ")).toMatch(/browser exploded/);
    expect(getActiveArmSession(db)).toBeFalsy();
  });

  it("windows spawns npm via a shell (cmd shims); unix does not", () => {
    // The live regression: execFileSync("npm") ENOENTs on win32 because
    // npm is npm.cmd — a shell is required to resolve the shim.
    expect(execOptionsForPlatform("win32").shell).toBe(true);
    expect(execOptionsForPlatform("linux").shell).toBe(false);
    expect(execOptionsForPlatform("darwin").shell).toBe(false);
  });

  it("a typecheck spawn failure surfaces the REAL error, not a bare refusal", async () => {
    armEnv();
    const r = await runAutoCycle(
      {},
      {
        db,
        exec: (cmd: string, args: string[]): string => {
          // Self-update phase succeeds with no movement...
          if (cmd === "git") return "abc12345";
          // ...then npm dies the way Windows kills a shim spawn.
          throw new Error("spawnSync npm ENOENT");
        },
        sessionRunner: async () => {
          throw new Error("must not run");
        },
      },
    );
    expect(r.outcome).toBe("refused");
    expect(r.preflight.notes.join(" ")).toMatch(/ENOENT/);
  });

  it("every cycle persists its report under artifacts/console/auto-cycle", async () => {
    const artDir = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-cycle-art-"));
    process.env.ARTIFACTS_DIR = artDir;
    resetConfigCache();
    try {
      const r = await runAutoCycle(
        { skipUpdate: true },
        { db, exec: noExec, sessionRunner: async () => { throw new Error("must not run"); } },
      );
      expect(r.outcome).toBe("refused"); // safe env — flags off
      const dir = path.join(artDir, "console", "auto-cycle");
      const files = fs.readdirSync(dir);
      expect(files.length).toBe(1);
      const persisted = JSON.parse(
        fs.readFileSync(path.join(dir, files[0]!), "utf8"),
      ) as { outcome: string; preflight: { notes: string[] } };
      expect(persisted.outcome).toBe("refused");
      expect(persisted.preflight.notes.join(" ")).toMatch(/AUTOMATION_ENABLED/);
    } finally {
      delete process.env.ARTIFACTS_DIR;
      resetConfigCache();
      fs.rmSync(artDir, { recursive: true, force: true });
    }
  });

  it("never double-arms when a session is already live", async () => {
    armEnv();
    const { armSession, hashArmToken } = await import(
      "../../src/automation/armSession.js"
    );
    armSession(db, { armedByTokenHash: hashArmToken("operator") });
    const r = await runAutoCycle(
      { skipUpdate: true },
      { db, exec: noExec, sessionRunner: async () => { throw new Error("must not run"); } },
    );
    expect(r.outcome).toBe("skipped_already_armed");
    // The EXISTING arm (someone else's session) is left alone.
    expect(getActiveArmSession(db)).toBeTruthy();
  });
});
