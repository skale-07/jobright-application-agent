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
import { acquireLease } from "../../src/queue/leases.js";
import { listOpenReviewItems, upsertOpenReviewItem, resolveReviewItem } from "../../src/queue/reviewItems.js";
import {
  getEmployerApplicationUrl,
  retryFailedApplications,
  runPipeline,
  setEmployerApplicationUrl,
  MAX_ATTEMPTS,
} from "../../src/pipeline/runPipeline.js";
import { registerResumeMaterial } from "../../src/jobright/materialsRegister.js";
import { saveHumanEssayAnswer } from "../../src/applications/essayAnswers.js";
import {
  applyControlledFillEnv,
  applySafeFillEnv,
} from "../helpers/fillEnvIsolation.js";
import { resetConfigCache } from "../../src/config/index.js";

const SYNTHETIC_PDF = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "ats",
  "greenhouse",
  "sample-resume.pdf",
);
const GREENHOUSE_FIXTURE = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "ats",
  "greenhouse",
  "dom.sanitized.html",
);
const ESSAY_FIXTURE = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "ats",
  "essay",
  "dom.sanitized.html",
);

describe("pipeline driver (FIXTURE_CONFIRMED)", () => {
  let dbPath: string;
  let artifactsDir: string;
  let db: Db;

  function seed(state = "QUEUED"): string {
    const jobNo = Math.floor(Math.random() * 1_000_000);
    const job = upsertJobByFingerprint(db, {
      jobrightJobId: `jr-${randomUUID().slice(0, 8)}`,
      applicationUrl: `https://jobright.ai/jobs/info/${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      company: `Acme${jobNo}`,
      role: "SWE Intern",
    });
    const app = createApplication(db, { jobId: job.id });
    db.prepare(`UPDATE applications SET state = ? WHERE id = ?`).run(
      state,
      app.id,
    );
    setEmployerApplicationUrl(
      db,
      app.id,
      `https://boards.greenhouse.io/acme/jobs/${jobNo}`,
    );
    return app.id;
  }

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `jaa-pipe-${randomUUID()}.sqlite`);
    artifactsDir = path.join(os.tmpdir(), `jaa-pipe-art-${randomUUID()}`);
    process.env.DATABASE_PATH = dbPath;
    process.env.ARTIFACTS_DIR = artifactsDir;
    applySafeFillEnv();
    db = openDatabase(dbPath);
    migrate(db);
  });

  afterEach(() => {
    closeDatabase(db);
    applySafeFillEnv();
    resetConfigCache();
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    fs.rmSync(artifactsDir, { recursive: true, force: true });
  });

  it("stores and validates the employer URL", () => {
    const appId = seed();
    expect(getEmployerApplicationUrl(db, appId)).toMatch(
      /boards\.greenhouse\.io/,
    );
    expect(() =>
      setEmployerApplicationUrl(db, appId, "https://evil.example.com/jobs/1"),
    ).toThrow(/Refusing to store/);
  });

  it("stops at materials with a MANUAL review item when no resume registered", async () => {
    const appId = seed();
    const report = await runPipeline({ db, applicationId: appId });
    const appRep = report.applications[0]!;
    expect(appRep.stopped).toBe("review");
    expect(getApplication(db, appId)?.state).toBe("MATERIALS_GENERATING");
    const items = listOpenReviewItems(db);
    expect(items.some((i) => /Resume material/i.test(i.title))).toBe(true);
  });

  it("stops on any pre-existing open review item before stepping", async () => {
    const appId = seed();
    upsertOpenReviewItem(db, {
      applicationId: appId,
      kind: "MANUAL",
      title: "operator hold",
    });
    const report = await runPipeline({ db, applicationId: appId });
    expect(report.applications[0]?.stopped).toBe("review");
    expect(getApplication(db, appId)?.state).toBe("QUEUED");
  });

  it("walks QUEUED → READY_TO_SUBMIT on the greenhouse fixture with fill enabled", async () => {
    const appId = seed();
    registerResumeMaterial({ db, applicationId: appId, filePath: SYNTHETIC_PDF });
    applyControlledFillEnv({
      FORM_FILL_ENABLED: "true",
      DRY_RUN: "false",
      SUBMIT_ENABLED: "false",
    });
    const report = await runPipeline({
      db,
      applicationId: appId,
      fixtureHtmlPath: GREENHOUSE_FIXTURE,
    });
    const appRep = report.applications[0]!;
    expect(getApplication(db, appId)?.state).toBe("READY_TO_SUBMIT");
    expect(appRep.stopped).toBe("submit_boundary");
    expect(appRep.steps.map((s) => s.from)).toEqual([
      "QUEUED",
      "MATERIALS_GENERATING",
      "RESUME_DOWNLOADED",
      "APPLICATION_OPENING",
      "ATS_DETECTION",
      "APPLICATION_INSPECTION",
      "NATIVE_AUTOFILL_RUNNING",
      "READY_TO_SUBMIT",
    ]);
  }, 60_000);

  it("stops at the fill gate under DRY_RUN without mutating", async () => {
    const appId = seed();
    registerResumeMaterial({ db, applicationId: appId, filePath: SYNTHETIC_PDF });
    const report = await runPipeline({
      db,
      applicationId: appId,
      fixtureHtmlPath: GREENHOUSE_FIXTURE,
    });
    const appRep = report.applications[0]!;
    expect(appRep.stopped).toBe("gate");
    expect(getApplication(db, appId)?.state).toBe("NATIVE_AUTOFILL_RUNNING");
  }, 60_000);

  it("routes the essay fixture to ESSAY_REQUIRED and resumes after answers", async () => {
    const appId = seed();
    registerResumeMaterial({ db, applicationId: appId, filePath: SYNTHETIC_PDF });
    const first = await runPipeline({
      db,
      applicationId: appId,
      fixtureHtmlPath: ESSAY_FIXTURE,
    });
    expect(first.applications[0]?.stopped).toBe("review");
    expect(getApplication(db, appId)?.state).toBe("ESSAY_REQUIRED");
    const essayItem = listOpenReviewItems(db).find((i) => i.kind === "ESSAY");
    expect(essayItem).toBeTruthy();

    // Operator writes both essays (resume-essay), item resolves, state moves on.
    saveHumanEssayAnswer(db, { applicationId: appId, fieldKey: "why", text: "Mission." });
    saveHumanEssayAnswer(db, { applicationId: appId, fieldKey: "extra", text: "Robot." });
    resolveReviewItem(db, essayItem!.id, { by: "test" });
    db.prepare(`UPDATE applications SET state = 'FIELD_VERIFICATION' WHERE id = ?`).run(appId);

    const second = await runPipeline({ db, applicationId: appId });
    expect(second.applications[0]?.stopped).toBe("submit_boundary");
    expect(getApplication(db, appId)?.state).toBe("READY_TO_SUBMIT");
  }, 60_000);

  it("refuses a second concurrent run on the same application (lease)", async () => {
    const appId = seed();
    acquireLease(db, {
      resourceType: "application",
      resourceId: `${appId}:pipeline`,
      holderRunId: "other-run",
      ttlMs: 60_000,
    });
    await expect(runPipeline({ db, applicationId: appId })).rejects.toThrow(
      /lease/i,
    );
  });

  it("SUBMITTED completes when no jobright session exists for contacts", async () => {
    const appId = seed("SUBMITTED");
    const report = await runPipeline({ db, applicationId: appId });
    expect(getApplication(db, appId)?.state).toBe("COMPLETED");
    expect(report.applications[0]?.steps[0]?.note).toMatch(
      /no jobright session/,
    );
  });

  it("SUBMITTED extracts fixture contacts, then gates on outreach generation flag", async () => {
    const appId = seed("SUBMITTED");
    const contactsFixture = path.join(
      process.cwd(),
      "tests",
      "fixtures",
      "jobright",
      "contacts",
      "dom.sanitized.html",
    );
    // EMAIL_GENERATION_ENABLED is off (safe env) → CONTACTS_EXTRACTED
    // falls through to COMPLETED.
    const report = await runPipeline({
      db,
      applicationId: appId,
      contactsFixtureHtmlPath: contactsFixture,
    });
    expect(getApplication(db, appId)?.state).toBe("COMPLETED");
    const notes = report.applications[0]!.steps.map((s) => s.note).join(" | ");
    expect(notes).toMatch(/contacts extracted: 3/);
    expect(notes).toMatch(/EMAIL_GENERATION_ENABLED off/);
  });
});

describe("retry driver (UNIT_CONFIRMED)", () => {
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    resetConfigCache();
    dbPath = path.join(os.tmpdir(), `jaa-retry-${randomUUID()}.sqlite`);
    process.env.DATABASE_PATH = dbPath;
    db = openDatabase(dbPath);
    migrate(db);
  });

  afterEach(() => {
    closeDatabase(db);
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  function seedFailed(attempt: number): string {
    const job = upsertJobByFingerprint(db, {
      jobrightJobId: `jr-${randomUUID().slice(0, 8)}`,
      applicationUrl: `https://boards.greenhouse.io/acme/jobs/${Math.floor(Math.random() * 1e6)}`,
      company: "Acme",
      role: "Intern",
    });
    const app = createApplication(db, { jobId: job.id });
    db.prepare(
      `UPDATE applications SET state = 'FAILED_RETRYABLE', attempt = ? WHERE id = ?`,
    ).run(attempt, app.id);
    return app.id;
  }

  it("requeues below the cap with attempt+1 and finalizes at the cap", () => {
    const under = seedFailed(1);
    const atCap = seedFailed(MAX_ATTEMPTS);
    const results = retryFailedApplications(db);

    const underResult = results.find((r) => r.application_id === under);
    expect(underResult?.action).toBe("requeued");
    expect(underResult?.attempt).toBe(2);
    expect(getApplication(db, under)?.state).toBe("QUEUED");

    const capResult = results.find((r) => r.application_id === atCap);
    expect(capResult?.action).toBe("finalized");
    expect(getApplication(db, atCap)?.state).toBe("FAILED_FINAL");
  });
});
