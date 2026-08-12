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
  sweepAbandonedArmSessions,
  touchArmHeartbeat,
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

  /**
   * Live failure 2026-08-12: a killed session left its l3_session row
   * RUNNING, and the next three scheduled auto:cycle firings each read
   * "already armed" and exited 0 without touching an application. An arm
   * is a budget ledger held by a live worker, not a lock.
   */
  describe("abandoned-arm sweep", () => {
    const T0 = new Date("2026-08-08T00:00:00Z");

    it("leaves a heartbeating arm alone", () => {
      armSession(db, { armedByTokenHash: HASH }, T0);
      // 40 min in, worker still reporting.
      const t40 = new Date(T0.getTime() + 40 * 60_000);
      touchArmHeartbeat(db, getArmStatus(db, t40).arm_run_id!, t40);
      const t41 = new Date(T0.getTime() + 41 * 60_000);
      expect(sweepAbandonedArmSessions(db, { now: t41 })).toEqual([]);
      expect(getArmStatus(db, t41).armed).toBe(true);
    });

    it("completes an arm whose worker has gone silent", () => {
      const armed = armSession(db, { armedByTokenHash: HASH }, T0);
      // No heartbeat since arming; 20 min later the worker is gone.
      const t20 = new Date(T0.getTime() + 20 * 60_000);
      const swept = sweepAbandonedArmSessions(db, { now: t20 });
      expect(swept).toHaveLength(1);
      expect(swept[0]!.arm_run_id).toBe(armed.arm_run_id);
      expect(swept[0]!.silent_for_ms).toBeGreaterThanOrEqual(20 * 60_000);
      expect(getArmStatus(db, t20).armed).toBe(false);
      // The sweep is fail-CLOSED: a swept row can never fund a submit.
      expect(
        tryConsumeUnattendedSubmission(db, armed.arm_run_id!),
      ).toBe(false);
    });

    it("re-arming is possible immediately after a sweep (the schedule recovers)", () => {
      armSession(db, { armedByTokenHash: HASH }, T0);
      const t20 = new Date(T0.getTime() + 20 * 60_000);
      sweepAbandonedArmSessions(db, { now: t20 });
      const second = armSession(db, { armedByTokenHash: HASH }, t20);
      expect(second.armed).toBe(true);
      expect(second.apps_started).toBe(0);
    });

    it("a heartbeat keeps a long session alive across many iterations", () => {
      armSession(db, { armedByTokenHash: HASH }, T0);
      let t = T0;
      for (let i = 1; i <= 6; i++) {
        t = new Date(T0.getTime() + i * 10 * 60_000);
        const id = getArmStatus(db, t).arm_run_id;
        expect(id).not.toBeNull();
        touchArmHeartbeat(db, id!, t);
        expect(sweepAbandonedArmSessions(db, { now: t })).toEqual([]);
      }
      expect(getArmStatus(db, t).armed).toBe(true);
    });

    it("no arm at all is a no-op", () => {
      expect(sweepAbandonedArmSessions(db, { now: T0 })).toEqual([]);
    });
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
