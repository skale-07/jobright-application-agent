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
import { createApplication, getApplication } from "../../src/queue/stateMachine.js";
import { upsertJobByFingerprint } from "../../src/jobs/repository.js";
import {
  listOpenReviewItems,
  upsertOpenReviewItem,
  type ReviewKind,
} from "../../src/queue/reviewItems.js";
import { canTransition } from "../../src/queue/states.js";
import {
  ReviewResolverError,
  abandonApplication,
  dismissReviewItem,
  requeueAfterWall,
  requeueAmbiguousField,
  requeueUnsupportedAts,
  resolveUncertainSubmission,
} from "../../src/queue/reviewResolvers.js";
import { resetConfigCache } from "../../src/config/index.js";

describe("review resolvers (UNIT_CONFIRMED)", () => {
  let dbPath: string;
  let db: Db;

  function seed(state: string, kind: ReviewKind): { appId: string; itemId: string } {
    const job = upsertJobByFingerprint(db, {
      jobrightJobId: `jr-${randomUUID().slice(0, 8)}`,
      applicationUrl: `https://boards.greenhouse.io/acme/jobs/${Math.floor(Math.random() * 1e6)}`,
      company: "Acme",
      role: "SWE",
    });
    const app = createApplication(db, { jobId: job.id });
    db.prepare(`UPDATE applications SET state = ? WHERE id = ?`).run(state, app.id);
    const { item } = upsertOpenReviewItem(db, {
      applicationId: app.id,
      kind,
      title: `${kind} item`,
    });
    return { appId: app.id, itemId: item.id };
  }

  beforeEach(() => {
    resetConfigCache();
    dbPath = path.join(os.tmpdir(), `jaa-resolvers-${randomUUID()}.sqlite`);
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

  it("the two operator-requeue edges are now legal (deliberate state-machine change)", () => {
    expect(canTransition("CAPTCHA_REQUIRED", "APPLICATION_OPENING")).toBe(true);
    expect(canTransition("UNSUPPORTED_ATS", "APPLICATION_OPENING")).toBe(true);
    // Unrelated edges stay closed.
    expect(canTransition("CAPTCHA_REQUIRED", "READY_TO_SUBMIT")).toBe(false);
    expect(canTransition("UNSUPPORTED_ATS", "SUBMITTED")).toBe(false);
  });

  it("uncertain submission: submitted → SUBMITTED, not-submitted → FAILED_RETRYABLE (+requeue)", () => {
    const a = seed("SUBMISSION_VERIFICATION_FAILED", "UNCERTAIN_SUBMISSION");
    const r1 = resolveUncertainSubmission(db, {
      reviewItemId: a.itemId,
      outcome: "submitted",
    });
    expect(r1.application_state).toBe("SUBMITTED");
    expect(listOpenReviewItems(db).find((i) => i.id === a.itemId)).toBeUndefined();

    const b = seed("SUBMISSION_VERIFICATION_FAILED", "UNCERTAIN_SUBMISSION");
    const r2 = resolveUncertainSubmission(db, {
      reviewItemId: b.itemId,
      outcome: "not-submitted",
      requeue: true,
    });
    expect(r2.application_state).toBe("QUEUED");

    const c = seed("SUBMISSION_VERIFICATION_FAILED", "UNCERTAIN_SUBMISSION");
    const r3 = resolveUncertainSubmission(db, {
      reviewItemId: c.itemId,
      outcome: "not-submitted",
    });
    expect(r3.application_state).toBe("FAILED_RETRYABLE");
  });

  it("uncertain submission rejects other kinds and unknown items", () => {
    const a = seed("AUTH_REQUIRED", "AUTH_REQUIRED");
    expect(() =>
      resolveUncertainSubmission(db, { reviewItemId: a.itemId, outcome: "submitted" }),
    ).toThrow(ReviewResolverError);
    expect(() =>
      resolveUncertainSubmission(db, { reviewItemId: randomUUID(), outcome: "submitted" }),
    ).toThrow(/No open review item/);
  });

  it("requeueAfterWall transitions AUTH_REQUIRED and CAPTCHA_REQUIRED back to APPLICATION_OPENING", () => {
    for (const kind of ["AUTH_REQUIRED", "CAPTCHA_REQUIRED"] as const) {
      const s = seed(kind, kind);
      const r = requeueAfterWall(db, { reviewItemId: s.itemId, note: "cleared" });
      expect(r.application_state).toBe("APPLICATION_OPENING");
      expect(r.transition_skipped).toBeNull();
      expect(getApplication(db, s.appId)?.state).toBe("APPLICATION_OPENING");
    }
  });

  it("requeueAfterWall resolves item-only when the app already moved on", () => {
    const s = seed("QUEUED", "AUTH_REQUIRED"); // app no longer sits on the wall
    const r = requeueAfterWall(db, { reviewItemId: s.itemId });
    expect(r.transition_skipped).toMatch(/state is QUEUED/);
    expect(getApplication(db, s.appId)?.state).toBe("QUEUED");
    expect(listOpenReviewItems(db).find((i) => i.id === s.itemId)).toBeUndefined();
  });

  it("requeueUnsupportedAts stores a corrected URL then re-opens; refuses bad URLs", () => {
    const s = seed("UNSUPPORTED_ATS", "UNSUPPORTED_ATS");
    // Any https host is generic-fillable now; only a URL every validator
    // rejects (non-https) still refuses.
    expect(() =>
      requeueUnsupportedAts(db, {
        reviewItemId: s.itemId,
        employerUrl: "http://evil.example.com/jobs/1",
      }),
    ).toThrow(/Refusing to store/);
    // Item stays open after the refused URL.
    expect(listOpenReviewItems(db).find((i) => i.id === s.itemId)).toBeTruthy();

    const r = requeueUnsupportedAts(db, {
      reviewItemId: s.itemId,
      employerUrl: "https://boards.greenhouse.io/acme/jobs/123456",
    });
    expect(r.application_state).toBe("APPLICATION_OPENING");
    expect(r.transition_skipped).toBeNull();
  });

  it("requeueAmbiguousField → FIELD_VERIFICATION; abandon → FAILED_FINAL; dismiss never transitions", () => {
    const amb = seed("AMBIGUOUS_FIELD", "AMBIGUOUS_FIELD");
    expect(
      requeueAmbiguousField(db, { reviewItemId: amb.itemId }).application_state,
    ).toBe("FIELD_VERIFICATION");

    const ab = seed("CAPTCHA_REQUIRED", "CAPTCHA_REQUIRED");
    const abandoned = abandonApplication(db, { reviewItemId: ab.itemId });
    expect(abandoned.application_state).toBe("FAILED_FINAL");

    // Abandon from a terminal state (no FAILED_FINAL edge) resolves item-only.
    const noEdge = seed("COMPLETED", "MANUAL");
    const skipped = abandonApplication(db, { reviewItemId: noEdge.itemId });
    expect(skipped.transition_skipped).toMatch(/no FAILED_FINAL edge/);
    expect(getApplication(db, noEdge.appId)?.state).toBe("COMPLETED");

    const man = seed("READY_TO_SUBMIT", "MANUAL");
    const dismissed = dismissReviewItem(db, { reviewItemId: man.itemId, note: "noise" });
    expect(dismissed.application_state).toBe("READY_TO_SUBMIT");
    expect(getApplication(db, man.appId)?.state).toBe("READY_TO_SUBMIT");
    const row = db
      .prepare(`SELECT status, resolution_json FROM review_items WHERE id = ?`)
      .get(man.itemId) as { status: string; resolution_json: string };
    expect(row.status).toBe("DISMISSED");
    expect(JSON.parse(row.resolution_json)).toMatchObject({ operator_note: "noise" });
  });
});
