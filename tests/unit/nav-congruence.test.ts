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
import { upsertJobByFingerprint } from "../../src/jobs/repository.js";
import { createApplication } from "../../src/queue/stateMachine.js";
import {
  setEmployerApplicationUrl,
  getEmployerApplicationUrl,
} from "../../src/applications/employerUrl.js";
import {
  checkUrlCongruence,
  companyIdentity,
  extractOrgSlug,
  findApplicationsWithEmployerUrl,
} from "../../src/navigation/congruence.js";
import { auditEmployerUrls } from "../../src/navigation/auditEmployerUrls.js";
import { listOpenReviewItems } from "../../src/queue/reviewItems.js";
import { resetConfigCache } from "../../src/config/index.js";

/**
 * Resolution congruence — pinned on the REAL live failure: the nav agent
 * returned the same Cohere Ashby URL for three unrelated jobs (Energy
 * Systems Group, Postman, AMA Legal Solutions), and host-only acceptance
 * persisted all three. Every company/slug pair below is from that session.
 * UNIT_CONFIRMED.
 */
describe("URL congruence (UNIT_CONFIRMED)", () => {
  const COHERE_URL =
    "https://jobs.ashbyhq.com/cohere/36d1f52f-8270-4652-adf5-5303a0ff341b/application";

  it("rejects the live regression trio against the Cohere URL", () => {
    for (const company of [
      "Energy Systems Group (ESG)",
      "Postman",
      "AMA Legal Solutions ®",
    ]) {
      expect(checkUrlCongruence(company, COHERE_URL).verdict).toBe("mismatch");
    }
  });

  it("accepts the true owners of their own boards", () => {
    expect(checkUrlCongruence("Cohere", COHERE_URL).verdict).toBe("match");
    expect(
      checkUrlCongruence(
        "METR",
        "https://jobs.lever.co/metr/52fca070-da6a-441e-b1d1-8184c51b52e6/apply",
      ).verdict,
    ).toBe("match");
  });

  it("matches acronym slugs via initials and parenthetical aliases", () => {
    // "Energy Systems Group (ESG)" — both routes must reach slug "esg".
    expect(
      checkUrlCongruence(
        "Energy Systems Group (ESG)",
        "https://boards.greenhouse.io/esg/jobs/123",
      ).verdict,
    ).toBe("match");
    expect(
      checkUrlCongruence(
        "Energy Systems Group",
        "https://boards.greenhouse.io/esg/jobs/123",
      ).verdict,
    ).toBe("match");
  });

  it("legal suffixes and punctuation never break a match", () => {
    expect(
      checkUrlCongruence(
        "Postman, Inc.",
        "https://jobs.ashbyhq.com/postman/xyz/application",
      ).verdict,
    ).toBe("match");
    expect(
      checkUrlCongruence(
        "Cohere Health",
        "https://jobs.lever.co/cohere-health/abc",
      ).verdict,
    ).toBe("match");
  });

  it("unknown hosts are 'unknown', never a silent pass or block", () => {
    const v = checkUrlCongruence(
      "Anything",
      "https://careers.example.com/apply/123",
    );
    expect(v.verdict).toBe("unknown");
  });

  it("greenhouse embed URLs decode the org from ?for=", () => {
    expect(
      extractOrgSlug("https://boards.greenhouse.io/embed/job_app?for=acme&token=1"),
    ).toBe("acme");
  });

  it("companyIdentity strips ®, keeps initials, extracts aliases", () => {
    const id = companyIdentity("Energy Systems Group (ESG) ®");
    expect(id.initials).toBe("esg");
    expect(id.aliases).toContain("esg");
    expect(id.tokens).toEqual(["energy", "systems", "group"]);
  });
});

describe("employer-URL audit + duplicate detection (UNIT_CONFIRMED)", () => {
  let dbPath: string;
  let db: Db;
  let artDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ["DATABASE_PATH", "ARTIFACTS_DIR"]) savedEnv[k] = process.env[k];
    resetConfigCache();
    dbPath = path.join(os.tmpdir(), `jaa-navaudit-${randomUUID()}.sqlite`);
    artDir = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-navaudit-art-"));
    process.env.DATABASE_PATH = dbPath;
    process.env.ARTIFACTS_DIR = artDir;
    db = openDatabase(dbPath);
    migrate(db);
  });

  afterEach(() => {
    closeDatabase(db);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    fs.rmSync(artDir, { recursive: true, force: true });
    resetConfigCache();
  });

  const seedApp = (company: string, employerUrl?: string): string => {
    const job = upsertJobByFingerprint(db, {
      jobrightJobId: `jr-${randomUUID().slice(0, 8)}`,
      applicationUrl: `https://jobright.ai/jobs/info/${randomUUID().slice(0, 12)}`,
      company,
      role: "Intern",
    });
    const appId = createApplication(db, { jobId: job.id }).id;
    if (employerUrl) setEmployerApplicationUrl(db, appId, employerUrl);
    return appId;
  };

  it("findApplicationsWithEmployerUrl sees other holders, not itself", () => {
    const url = "https://jobs.ashbyhq.com/cohere/36d1f52f-8270-4652-adf5-5303a0ff341b/application";
    const a = seedApp("Cohere", url);
    const b = seedApp("Postman");
    expect(findApplicationsWithEmployerUrl(db, url, b).map((d) => d.application_id)).toEqual([a]);
    expect(findApplicationsWithEmployerUrl(db, url, a)).toEqual([]);
  });

  it("audit repairs the live poison shape: wrong-employer URL cleared, app re-navigates", () => {
    // Postman app wrongly holding Cohere's URL (the real bug).
    const poisoned = seedApp(
      "Postman",
      "https://jobs.ashbyhq.com/cohere/36d1f52f-8270-4652-adf5-5303a0ff341b/application",
    );
    const healthy = seedApp(
      "Cohere",
      "https://jobs.ashbyhq.com/cohere/36d1f52f-8270-4652-adf5-5303a0ff341b/application",
    );

    const report = auditEmployerUrls(db);
    expect(report.mismatches_found).toBe(1);
    expect(report.repaired).toBe(1);

    // Poisoned app: URL gone; it will re-navigate on its natural path.
    expect(getEmployerApplicationUrl(db, poisoned)).toBeNull();
    // The rightful owner keeps its URL untouched.
    expect(getEmployerApplicationUrl(db, healthy)).not.toBeNull();
  });

  it("audit parks duplicates: same congruent URL on two apps keeps the oldest", () => {
    const url = "https://jobs.lever.co/metr/52fca070-da6a-441e-b1d1-8184c51b52e6/apply";
    const first = seedApp("METR", url);
    const second = seedApp("METR", url);
    const report = auditEmployerUrls(db);
    expect(report.duplicates_parked).toBe(1);
    const items = listOpenReviewItems(db);
    const dupItem = items.find((i) => i.application_id === second);
    expect(dupItem?.title).toMatch(/Duplicate posting/);
    expect(items.some((i) => i.application_id === first)).toBe(false);
  });

  it("audit never auto-repairs past submit — it parks for a human", () => {
    const appId = seedApp(
      "Postman",
      "https://jobs.ashbyhq.com/cohere/36d1f52f-8270-4652-adf5-5303a0ff341b/application",
    );
    // Walk the app to SUBMITTED via legal edges (raw SQL keeps the test
    // honest about guarding on state, not on how it got there).
    db.prepare(`UPDATE applications SET state = 'SUBMITTED' WHERE id = ?`).run(appId);

    const report = auditEmployerUrls(db);
    expect(report.repaired).toBe(0);
    expect(report.parked).toBe(1);
    // URL intentionally NOT cleared — evidence for the human.
    expect(getEmployerApplicationUrl(db, appId)).not.toBeNull();
    const item = listOpenReviewItems(db).find((i) => i.application_id === appId);
    expect(item?.title).toMatch(/needs human review/);
  });
});
