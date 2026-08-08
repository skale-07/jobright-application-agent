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
import {
  ArmConflictError,
  armSession,
  consumeArmApplication,
  disarmSession,
  getActiveArmSession,
  getArmStatus,
  hashArmToken,
  sweepStaleArmSessions,
} from "../../src/automation/armSession.js";
import { tryConsumeUnattendedSubmission } from "../../src/queue/automationRuns.js";
import { resetConfigCache } from "../../src/config/index.js";

describe("L3 arm session (UNIT_CONFIRMED)", () => {
  let dbPath: string;
  let db: Db;
  const HASH = hashArmToken("boot-token-xyz");

  beforeEach(() => {
    resetConfigCache();
    dbPath = path.join(os.tmpdir(), `jaa-arm-${randomUUID()}.sqlite`);
    process.env.DATABASE_PATH = dbPath;
    db = openDatabase(dbPath);
    migrate(db);
  });

  afterEach(() => {
    closeDatabase(db);
    delete process.env.DATABASE_PATH;
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    resetConfigCache();
  });

  it("arms with defaults and clamps duration to 15–240", () => {
    const now = new Date("2026-08-08T00:00:00Z");
    const status = armSession(db, { armedByTokenHash: HASH }, now);
    expect(status.armed).toBe(true);
    expect(status.max_submits).toBe(10);
    expect(status.max_apps).toBe(25);
    // default 120 min
    expect(status.armed_until).toBe("2026-08-08T02:00:00.000Z");
    expect(status.seconds_remaining).toBe(120 * 60);

    disarmSession(db, now);
    const low = armSession(db, { durationMinutes: 5, armedByTokenHash: HASH }, now);
    expect(low.armed_until).toBe("2026-08-08T00:15:00.000Z"); // clamped up to 15
    disarmSession(db, now);
    const high = armSession(db, { durationMinutes: 999, armedByTokenHash: HASH }, now);
    expect(high.armed_until).toBe("2026-08-08T04:00:00.000Z"); // clamped to 240 min
  });

  it("refuses a second arm while one is active (409)", () => {
    armSession(db, { armedByTokenHash: HASH });
    expect(() => armSession(db, { armedByTokenHash: HASH })).toThrow(
      ArmConflictError,
    );
  });

  it("an expired-but-RUNNING row reads as disarmed and is swept", () => {
    const t0 = new Date("2026-08-08T00:00:00Z");
    armSession(db, { durationMinutes: 15, armedByTokenHash: HASH }, t0);
    // Row exists and is RUNNING…
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM automation_runs WHERE status='RUNNING'`).get() as { n: number }).n,
    ).toBe(1);
    const later = new Date("2026-08-08T01:00:00Z"); // past armed_until
    expect(getArmStatus(db, later).armed).toBe(false);
    expect(getActiveArmSession(db, later)).toBeUndefined();
    // …lazily completed by the status read.
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM automation_runs WHERE status='RUNNING'`).get() as { n: number }).n,
    ).toBe(0);
  });

  it("sweep completes all RUNNING l3_session rows (restart = disarmed)", () => {
    armSession(db, { armedByTokenHash: HASH });
    expect(sweepStaleArmSessions(db)).toBe(1);
    expect(getArmStatus(db).armed).toBe(false);
    // Idempotent.
    expect(sweepStaleArmSessions(db)).toBe(0);
  });

  it("consumeArmApplication is capped at max_apps and refuses when disarmed", () => {
    const now = new Date("2026-08-08T00:00:00Z");
    const s = armSession(db, { maxApps: 2, armedByTokenHash: HASH }, now);
    const armId = s.arm_run_id!;
    expect(consumeArmApplication(db, armId, now)).toBe(true);
    expect(consumeArmApplication(db, armId, now)).toBe(true);
    expect(consumeArmApplication(db, armId, now)).toBe(false); // cap reached
    expect(getArmStatus(db, now).apps_started).toBe(2);

    disarmSession(db, now);
    expect(consumeArmApplication(db, armId, now)).toBe(false); // not RUNNING
  });

  it("the arm row IS the unattended-submit budget", () => {
    const s = armSession(db, { maxSubmits: 2, armedByTokenHash: HASH });
    const armId = s.arm_run_id!;
    expect(tryConsumeUnattendedSubmission(db, armId)).toBe(true);
    expect(tryConsumeUnattendedSubmission(db, armId)).toBe(true);
    expect(tryConsumeUnattendedSubmission(db, armId)).toBe(false); // cap
    expect(getArmStatus(db).submits_used).toBe(2);

    // Disarm makes further consumption structurally impossible (fail-closed).
    disarmSession(db);
    expect(tryConsumeUnattendedSubmission(db, armId)).toBe(false);
  });

  it("token hash is short and non-reversible-ish; never the raw token", () => {
    expect(HASH).toHaveLength(16);
    expect(HASH).not.toContain("boot-token");
  });
});
