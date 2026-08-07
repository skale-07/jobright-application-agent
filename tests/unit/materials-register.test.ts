import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
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
  getRegisteredResume,
  registerResumeMaterial,
} from "../../src/jobright/materialsRegister.js";
import { resetConfigCache } from "../../src/config/index.js";

const SYNTHETIC_PDF = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "ats",
  "greenhouse",
  "sample-resume.pdf",
);

describe("materials:register (UNIT_CONFIRMED)", () => {
  let dbPath: string;
  let artifactsDir: string;
  let db: Db;
  let applicationId: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `jaa-matreg-${randomUUID()}.sqlite`);
    artifactsDir = path.join(os.tmpdir(), `jaa-matreg-art-${randomUUID()}`);
    process.env.DATABASE_PATH = dbPath;
    process.env.ARTIFACTS_DIR = artifactsDir;
    resetConfigCache();
    db = openDatabase(dbPath);
    migrate(db);
    const job = upsertJobByFingerprint(db, {
      jobrightJobId: `jr-${randomUUID().slice(0, 8)}`,
      applicationUrl: "https://boards.greenhouse.io/acme/jobs/1",
      company: "Acme",
      role: "SWE Intern",
    });
    applicationId = createApplication(db, { jobId: job.id }).id;
  });

  afterEach(() => {
    closeDatabase(db);
    resetConfigCache();
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    fs.rmSync(artifactsDir, { recursive: true, force: true });
  });

  it("registers the synthetic PDF as a verified material with matching sha256", () => {
    const expectedSha = createHash("sha256")
      .update(fs.readFileSync(SYNTHETIC_PDF))
      .digest("hex");
    const result = registerResumeMaterial({
      db,
      applicationId,
      filePath: SYNTHETIC_PDF,
      label: "swe",
    });
    expect(result.sha256).toBe(expectedSha);
    expect(fs.existsSync(result.path)).toBe(true);

    const row = db
      .prepare(
        `SELECT kind, verified, metadata_json FROM materials WHERE id = ?`,
      )
      .get(result.material_id) as {
      kind: string;
      verified: number;
      metadata_json: string;
    };
    expect(row.kind).toBe("resume");
    expect(row.verified).toBe(1);
    expect(JSON.parse(row.metadata_json)).toMatchObject({
      source: "operator_registered",
      label: "swe",
    });
    expect(getRegisteredResume(db, applicationId)?.sha256).toBe(expectedSha);
  });

  it("rejects a non-PDF file", () => {
    const bogus = path.join(os.tmpdir(), `jaa-notpdf-${randomUUID()}.pdf`);
    fs.writeFileSync(bogus, "this is not a pdf at all, just text padding....");
    try {
      expect(() =>
        registerResumeMaterial({ db, applicationId, filePath: bogus }),
      ).toThrow(/PDF/i);
      expect(getRegisteredResume(db, applicationId)).toBeNull();
    } finally {
      fs.unlinkSync(bogus);
    }
  });

  it("rejects a missing file and an unknown application", () => {
    expect(() =>
      registerResumeMaterial({
        db,
        applicationId,
        filePath: "/nonexistent/resume.pdf",
      }),
    ).toThrow(/not found/i);
    expect(() =>
      registerResumeMaterial({
        db,
        applicationId: randomUUID(),
        filePath: SYNTHETIC_PDF,
      }),
    ).toThrow(/Unknown application/);
  });

  it("re-register upserts the single resume slot (UNIQUE app+kind)", () => {
    const first = registerResumeMaterial({
      db,
      applicationId,
      filePath: SYNTHETIC_PDF,
      label: "v1",
    });
    const second = registerResumeMaterial({
      db,
      applicationId,
      filePath: SYNTHETIC_PDF,
      label: "v2",
    });
    const rows = db
      .prepare(
        `SELECT COUNT(*) AS n FROM materials WHERE application_id = ? AND kind = 'resume'`,
      )
      .get(applicationId) as { n: number };
    expect(rows.n).toBe(1);
    expect(second.sha256).toBe(first.sha256);
    const meta = db
      .prepare(`SELECT metadata_json FROM materials WHERE application_id = ?`)
      .get(applicationId) as { metadata_json: string };
    expect(JSON.parse(meta.metadata_json).label).toBe("v2");
  });
});
