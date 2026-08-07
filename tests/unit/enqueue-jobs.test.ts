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
import { getApplication } from "../../src/queue/stateMachine.js";
import {
  enqueueJobRightJobs,
  expandJobRightRefs,
  parseJobRightRef,
} from "../../src/jobright/enqueueJobs.js";
import { getStoredJobInspectionTarget } from "../../src/jobright/storedJobTarget.js";
import { resetConfigCache } from "../../src/config/index.js";

describe("parseJobRightRef (UNIT_CONFIRMED)", () => {
  it("accepts bare hex id and full detail URL", () => {
    const id = "6a76229767a1ad0bc53c8e9f";
    const fromId = parseJobRightRef(id);
    expect(fromId.ok).toBe(true);
    if (fromId.ok) {
      expect(fromId.jobright_job_id).toBe(id);
      expect(fromId.job_url).toBe(
        `https://jobright.ai/jobs/info/${id}`,
      );
    }

    const fromUrl = parseJobRightRef(
      `https://jobright.ai/jobs/info/${id}?utm=x`,
    );
    expect(fromUrl.ok).toBe(true);
    if (fromUrl.ok) {
      expect(fromUrl.jobright_job_id).toBe(id);
      expect(fromUrl.job_url).toBe(`https://jobright.ai/jobs/info/${id}`);
    }
  });

  it("rejects non-jobright hosts and garbage", () => {
    expect(parseJobRightRef("").ok).toBe(false);
    expect(parseJobRightRef("not-a-job").ok).toBe(false);
    expect(
      parseJobRightRef(
        "https://boards.greenhouse.io/acme/jobs/1",
      ).ok,
    ).toBe(false);
  });

  it("expandJobRightRefs dedupes, splits commas, ignores comments", () => {
    const expanded = expandJobRightRefs([
      "6a76229767a1ad0bc53c8e9f, 6a76229767a1ad0bc53c8e9f",
      "# comment",
      "https://jobright.ai/jobs/info/aaaaaaaaaaaaaaaaaaaaaaaa",
    ]);
    expect(expanded).toHaveLength(2);
  });
});

describe("enqueueJobRightJobs (UNIT_CONFIRMED)", () => {
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `jaa-enqueue-${randomUUID()}.sqlite`);
    process.env.DATABASE_PATH = dbPath;
    resetConfigCache();
    db = openDatabase(dbPath);
    migrate(db);
  });

  afterEach(() => {
    closeDatabase(db);
    resetConfigCache();
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it("creates QUEUED applications with application UUIDs for multiple links", () => {
    const id1 = "6a76229767a1ad0bc53c8e9f";
    const id2 = "bbbbbbbbbbbbbbbbbbbbbbbb";
    const report = enqueueJobRightJobs(db, [
      `https://jobright.ai/jobs/info/${id1}`,
      id2,
    ]);
    expect(report.failed).toBe(0);
    expect(report.enqueued).toBe(2);
    expect(report.applications).toHaveLength(2);

    for (const row of report.applications) {
      expect(row.ok).toBe(true);
      expect(row.application_id).toMatch(
        /^[0-9a-f-]{36}$/i,
      );
      expect(row.state).toBe("QUEUED");
      expect(row.dedupe_kind).toBe("CREATED");
      const app = getApplication(db, row.application_id!);
      expect(app?.state).toBe("QUEUED");
    }

    const resolved = getStoredJobInspectionTarget(db, id1);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.target.applicationId).toBe(
        report.applications[0]!.application_id,
      );
      expect(resolved.target.jobUrl).toContain(id1);
    }
  });

  it("reuses the same application on second enqueue of the same id", () => {
    const id = "6a76229767a1ad0bc53c8e9f";
    const first = enqueueJobRightJobs(db, [id]);
    const second = enqueueJobRightJobs(db, [
      `https://jobright.ai/jobs/info/${id}`,
    ]);
    expect(first.enqueued).toBe(1);
    expect(second.enqueued).toBe(0);
    expect(second.reused).toBe(1);
    expect(second.applications[0]!.application_id).toBe(
      first.applications[0]!.application_id,
    );
  });

  it("stores optional employer apply URL on job raw_json", () => {
    const id = "6a76229767a1ad0bc53c8e9f";
    const gh =
      "https://job-boards.greenhouse.io/simplifyjobsintegrationsandbox/jobs/4344358003";
    const report = enqueueJobRightJobs(db, [id], {
      employerApplicationUrl: gh,
    });
    const jobId = report.applications[0]!.job_db_id!;
    const raw = JSON.parse(
      (
        db.prepare(`SELECT raw_json FROM jobs WHERE id = ?`).get(jobId) as {
          raw_json: string;
        }
      ).raw_json,
    ) as Record<string, unknown>;
    expect(raw["employer_application_url"]).toBe(gh);
    expect(raw["employer_application_ats"]).toBe("greenhouse");
  });

  it("accepts a lever employer URL, normalizing to /apply (W3)", () => {
    const id = "6a76229767a1ad0bc53c8e91";
    const report = enqueueJobRightJobs(db, [id], {
      employerApplicationUrl:
        "https://jobs.lever.co/acme/a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    });
    expect(report.enqueued).toBe(1);
    const jobId = report.applications[0]!.job_db_id!;
    const raw = JSON.parse(
      (
        db.prepare(`SELECT raw_json FROM jobs WHERE id = ?`).get(jobId) as {
          raw_json: string;
        }
      ).raw_json,
    ) as Record<string, unknown>;
    expect(raw["employer_application_url"]).toBe(
      "https://jobs.lever.co/acme/a1b2c3d4-e5f6-7890-abcd-ef1234567890/apply",
    );
    expect(raw["employer_application_ats"]).toBe("lever");
  });

  it("stores an unsupported-ATS https URL verbatim for pipeline routing (W3/W7)", () => {
    // The pipeline routes these to UNSUPPORTED_ATS + review item — the
    // tracked path. Only malformed URLs are refused at ingestion.
    const id = "6a76229767a1ad0bc53c8e92";
    const report = enqueueJobRightJobs(db, [id], {
      employerApplicationUrl: "https://careers.example.com/apply/123",
    });
    expect(report.enqueued).toBe(1);
    const jobId = report.applications[0]!.job_db_id!;
    const raw = JSON.parse(
      (
        db.prepare(`SELECT raw_json FROM jobs WHERE id = ?`).get(jobId) as {
          raw_json: string;
        }
      ).raw_json,
    ) as Record<string, unknown>;
    expect(raw["employer_application_url"]).toBe(
      "https://careers.example.com/apply/123",
    );
    expect(raw["employer_application_ats"]).toBeNull();
  });

  it("refuses malformed or non-https employer URLs at ingestion (W7)", () => {
    const id = "6a76229767a1ad0bc53c8e93";
    for (const bad of ["not a url", "http://jobs.lever.co/acme/x", "javascript:alert(1)"]) {
      const report = enqueueJobRightJobs(db, [id], {
        employerApplicationUrl: bad,
      });
      expect(report.failed).toBe(1);
      expect(report.applications[0]!.error).toMatch(/employer URL rejected/);
    }
  });
});
