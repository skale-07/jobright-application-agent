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
import { createApplication } from "../../src/queue/stateMachine.js";
import { upsertJobByFingerprint } from "../../src/jobs/repository.js";
import {
  ensureResumeForApplication,
  getRegisteredResume,
  registerResumeMaterial,
} from "../../src/jobright/materialsRegister.js";
import { resetConfigCache } from "../../src/config/index.js";

const REAL_PDF = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "ats",
  "greenhouse",
  "sample-resume.pdf",
);

describe("default resume auto-attach (UNIT_CONFIRMED)", () => {
  let tmpDir: string;
  let db: Db;
  let appId: string;

  beforeEach(() => {
    resetConfigCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-defres-"));
    process.env.DATABASE_PATH = path.join(tmpDir, "app.sqlite");
    db = openDatabase(process.env.DATABASE_PATH);
    migrate(db);
    const job = upsertJobByFingerprint(db, {
      jobrightJobId: `jr-${randomUUID().slice(0, 8)}`,
      applicationUrl: `https://boards.greenhouse.io/acme/jobs/${Math.floor(Math.random() * 1e6)}`,
      company: "Acme",
      role: "SWE",
    });
    appId = createApplication(db, { jobId: job.id }).id;
  });

  afterEach(() => {
    closeDatabase(db);
    delete process.env.DATABASE_PATH;
    delete process.env.DEFAULT_RESUME_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetConfigCache();
  });

  it("no_default when the file is absent; leaves the app without a resume", () => {
    process.env.DEFAULT_RESUME_PATH = path.join(tmpDir, "missing.pdf");
    resetConfigCache();
    expect(ensureResumeForApplication(db, appId)).toBe("no_default");
    expect(getRegisteredResume(db, appId)).toBeNull();
  });

  it("attaches the default (label 'default') when the file exists", () => {
    const defaultPath = path.join(tmpDir, "default.pdf");
    fs.copyFileSync(REAL_PDF, defaultPath);
    process.env.DEFAULT_RESUME_PATH = defaultPath;
    resetConfigCache();

    expect(ensureResumeForApplication(db, appId)).toBe("attached");
    const resume = getRegisteredResume(db, appId);
    expect(resume).not.toBeNull();
    // A second call is a no-op (already registered).
    expect(ensureResumeForApplication(db, appId)).toBe("already");
  });

  it("is a no-op when a resume is already registered (never overwrites)", () => {
    registerResumeMaterial({ db, applicationId: appId, filePath: REAL_PDF, label: "swe" });
    const before = getRegisteredResume(db, appId)!;
    // Even with a different default configured, an existing resume wins.
    const defaultPath = path.join(tmpDir, "default.pdf");
    fs.copyFileSync(REAL_PDF, defaultPath);
    process.env.DEFAULT_RESUME_PATH = defaultPath;
    resetConfigCache();

    expect(ensureResumeForApplication(db, appId)).toBe("already");
    expect(getRegisteredResume(db, appId)!.path).toBe(before.path);
  });
});
