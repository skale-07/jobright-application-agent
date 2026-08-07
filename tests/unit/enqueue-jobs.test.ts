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
  });
});
