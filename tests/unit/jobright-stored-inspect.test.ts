import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigCache } from "../../src/config/index.js";
import { closeDatabase, migrate, openDatabase } from "../../src/storage/db/client.js";
import { createApplication } from "../../src/queue/stateMachine.js";
import { parseJobCardsFromFeedHtml } from "../../src/jobright/jobFeed.js";
import {
  buildJobRightDetailUrlFromId,
  resolveCanonicalInspectionUrl,
  validateJobRightInspectionUrl,
} from "../../src/jobright/jobInspectionUrl.js";
import {
  classifyInspectionRedirect,
  verifyJobIdentity,
} from "../../src/jobright/jobIdentityVerification.js";
import {
  getStoredJobInspectionTarget,
  getStoredJobInspectionTargetByApplicationId,
} from "../../src/jobright/storedJobTarget.js";
import {
  inspectStoredJobrightJob,
  type StoredJobInspectionReport,
} from "../../src/jobright/inspectStoredJob.js";
import { inspectJobRightControlVisibility } from "../../src/jobright/controlVisibility.js";
import type { Page } from "playwright";

const feedFixture = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "jobright",
  "job-feed",
  "dom.sanitized.html",
);
const detailFixture = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "jobright",
  "job-detail",
  "dom.sanitized.html",
);

const STORED_ID = "aabbccddeeff001122334455";
const ABSENT_FROM_FEED_ID = "ffffffffffffffffffffffffffff01";

function forceSafeEnv(): void {
  process.env.FORM_FILL_ENABLED = "false";
  process.env.DRY_RUN = "true";
  process.env.SUBMIT_ENABLED = "false";
  resetConfigCache();
}

function seedJob(opts: {
  dbPath: string;
  artifactsDir: string;
  jobrightJobId: string;
  company: string;
  role: string;
  jobUrl?: string;
  withApplication?: boolean;
}): { db: ReturnType<typeof openDatabase>; applicationId: string | null; jobDbId: string } {
  process.env.DATABASE_PATH = opts.dbPath;
  process.env.ARTIFACTS_DIR = opts.artifactsDir;
  forceSafeEnv();
  const db = openDatabase(opts.dbPath);
  migrate(db);
  const jobDbId = randomUUID();
  const now = new Date().toISOString();
  const jobUrl =
    opts.jobUrl ?? `https://jobright.ai/jobs/info/${opts.jobrightJobId}`;
  const raw = {
    jobright_job_id: opts.jobrightJobId,
    job_url: jobUrl,
    job_path: `/jobs/info/${opts.jobrightJobId}`,
    company: opts.company,
    role: opts.role,
  };
  db.prepare(
    `INSERT INTO jobs (
      id, jobright_job_id, normalized_application_url, company, role,
      job_fingerprint, raw_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jobDbId,
    opts.jobrightJobId,
    jobUrl.toLowerCase(),
    opts.company,
    opts.role,
    `fp-${opts.jobrightJobId}`,
    JSON.stringify(raw),
    now,
    now,
  );
  let applicationId: string | null = null;
  if (opts.withApplication !== false) {
    const app = createApplication(db, { jobId: jobDbId });
    applicationId = app.id;
  }
  return { db, applicationId, jobDbId };
}

describe("stored JobRight inspection — URL validation (UNIT_CONFIRMED)", () => {
  it("uses persisted canonical URL when present", () => {
    const r = resolveCanonicalInspectionUrl({
      jobrightJobId: STORED_ID,
      persistedUrl: `https://jobright.ai/jobs/info/${STORED_ID}?utm_source=x`,
      jobPath: null,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url).toBe(`https://jobright.ai/jobs/info/${STORED_ID}`);
    }
  });

  it("constructs from trusted path when needed", () => {
    const r = resolveCanonicalInspectionUrl({
      jobrightJobId: STORED_ID,
      persistedUrl: null,
      jobPath: `/jobs/info/${STORED_ID}`,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toContain(STORED_ID);
  });

  it("builds from id when nothing persisted", () => {
    const r = buildJobRightDetailUrlFromId(STORED_ID);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url).toBe(`https://jobright.ai/jobs/info/${STORED_ID}`);
    }
  });

  it("rejects external origins", () => {
    const r = validateJobRightInspectionUrl(
      "https://boards.greenhouse.io/acme/jobs/1",
      STORED_ID,
    );
    expect(r.ok).toBe(false);
  });

  it("rejects malformed ids", () => {
    expect(buildJobRightDetailUrlFromId("not-an-id").ok).toBe(false);
    expect(buildJobRightDetailUrlFromId("javascript:alert(1)").ok).toBe(false);
  });

  it("rejects path and id mismatch", () => {
    const r = validateJobRightInspectionUrl(
      "https://jobright.ai/jobs/info/aaaaaaaaaaaaaaaaaaaaaaaa",
      STORED_ID,
    );
    expect(r.ok).toBe(false);
  });

  it("rejects javascript and data URLs", () => {
    expect(
      validateJobRightInspectionUrl("javascript:alert(1)", STORED_ID).ok,
    ).toBe(false);
    expect(
      validateJobRightInspectionUrl("data:text/html,hi", STORED_ID).ok,
    ).toBe(false);
  });
});

describe("stored JobRight inspection — identity (UNIT_CONFIRMED)", () => {
  const base = {
    requestedJobrightJobId: STORED_ID,
    finalUrl: `https://jobright.ai/jobs/info/${STORED_ID}`,
    parsedJobrightJobId: STORED_ID,
    storedCompany: "Amazon",
    visibleCompany: "Amazon",
    storedRole: "Software Development Engineer Internship - Fall 2026 (US)",
    visibleRole: "Software Development Engineer Internship - Fall 2026 (US)",
  };

  it("matching id, role, and company passes", () => {
    expect(verifyJobIdentity(base).passed).toBe(true);
  });

  it("whitespace-only differences warn but pass", () => {
    const r = verifyJobIdentity({
      ...base,
      visibleCompany: "  Amazon  ",
      visibleRole: "Software Development Engineer Internship  -  Fall 2026 (US)",
    });
    expect(r.passed).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("different job id fails", () => {
    const r = verifyJobIdentity({
      ...base,
      parsedJobrightJobId: "bbbbbbbbbbbbbbbbbbbbbbbb",
    });
    expect(r.passed).toBe(false);
  });

  it("conflicting company fails", () => {
    const r = verifyJobIdentity({
      ...base,
      visibleCompany: "Scale AI",
    });
    expect(r.passed).toBe(false);
  });

  it("materially different role fails", () => {
    const r = verifyJobIdentity({
      ...base,
      visibleRole: "Chief Financial Officer",
    });
    expect(r.passed).toBe(false);
  });

  it("login redirect fails", () => {
    expect(
      classifyInspectionRedirect(
        "https://jobright.ai/login",
        STORED_ID,
      ).kind,
    ).toBe("fail");
  });

  it("recommendation-feed redirect fails", () => {
    expect(
      classifyInspectionRedirect(
        "https://jobright.ai/jobs/recommend",
        STORED_ID,
      ).kind,
    ).toBe("fail");
  });

  it("external ATS redirect fails", () => {
    expect(
      classifyInspectionRedirect(
        "https://boards.greenhouse.io/acme/jobs/1",
        STORED_ID,
      ).kind,
    ).toBe("fail");
  });
});

describe("stored JobRight inspection — SQLite resolver (UNIT_CONFIRMED)", () => {
  let dbPath: string;
  let artifactsDir: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `jaa-inspect-${randomUUID()}.sqlite`);
    artifactsDir = path.join(os.tmpdir(), `jaa-inspect-art-${randomUUID()}`);
  });

  afterEach(() => {
    resetConfigCache();
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it("resolves known stored job with canonical URL and does not create apps", () => {
    const { db, applicationId, jobDbId } = seedJob({
      dbPath,
      artifactsDir,
      jobrightJobId: STORED_ID,
      company: "Amazon",
      role: "Software Development Engineer Internship - Fall 2026 (US)",
    });
    try {
      const before = (
        db.prepare(`SELECT COUNT(*) AS n FROM applications`).get() as {
          n: number;
        }
      ).n;
      const stateBefore = (
        db
          .prepare(`SELECT state FROM applications WHERE id = ?`)
          .get(applicationId!) as { state: string }
      ).state;

      const resolved = getStoredJobInspectionTarget(db, STORED_ID);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      expect(resolved.target.jobrightJobId).toBe(STORED_ID);
      expect(resolved.target.jobUrl).toBe(
        `https://jobright.ai/jobs/info/${STORED_ID}`,
      );
      expect(resolved.target.jobDbId).toBe(jobDbId);
      expect(resolved.target.applicationId).toBe(applicationId);

      const after = (
        db.prepare(`SELECT COUNT(*) AS n FROM applications`).get() as {
          n: number;
        }
      ).n;
      const stateAfter = (
        db
          .prepare(`SELECT state FROM applications WHERE id = ?`)
          .get(applicationId!) as { state: string }
      ).state;
      expect(after).toBe(before);
      expect(stateAfter).toBe(stateBefore);
    } finally {
      closeDatabase(db);
    }
  });

  it("returns NOT_FOUND for unknown id", () => {
    const { db } = seedJob({
      dbPath,
      artifactsDir,
      jobrightJobId: STORED_ID,
      company: "Amazon",
      role: "Intern",
    });
    try {
      const resolved = getStoredJobInspectionTarget(db, "eeeeeeeeeeeeeeeeeeeeeeee");
      expect(resolved.ok).toBe(false);
      if (!resolved.ok) expect(resolved.code).toBe("NOT_FOUND");
    } finally {
      closeDatabase(db);
    }
  });

  it("resolves via application UUID", () => {
    const { db, applicationId } = seedJob({
      dbPath,
      artifactsDir,
      jobrightJobId: STORED_ID,
      company: "Amazon",
      role: "Intern",
    });
    try {
      const resolved = getStoredJobInspectionTargetByApplicationId(
        db,
        applicationId!,
      );
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.target.jobrightJobId).toBe(STORED_ID);
      }
    } finally {
      closeDatabase(db);
    }
  });
});

describe("stored JobRight inspection — fixture no-mutation + feed independence (FIXTURE_CONFIRMED)", () => {
  let dbPath: string;
  let artifactsDir: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `jaa-inspect-fx-${randomUUID()}.sqlite`);
    artifactsDir = path.join(os.tmpdir(), `jaa-inspect-fx-art-${randomUUID()}`);
    forceSafeEnv();
  });

  afterEach(() => {
    resetConfigCache();
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        // Windows may briefly lock SQLite files after close
      }
    }
  });

  it("mock page control inspection never clicks/fills/presses", async () => {
    const calls: string[] = [];
    const makeLocator = (text: string | null = null, visible = false) => {
      const loc = {
        first: () => loc,
        textContent: async () => {
          calls.push("textContent");
          return text;
        },
        isVisible: async () => {
          calls.push("isVisible");
          return visible;
        },
        isDisabled: async () => {
          calls.push("isDisabled");
          return false;
        },
        getAttribute: async () => {
          calls.push("getAttribute");
          return null;
        },
        count: async () => {
          calls.push("count");
          return visible ? 1 : 0;
        },
        innerText: async () => {
          calls.push("innerText");
          return "fixture body";
        },
        click: async () => {
          calls.push("click");
          throw new Error("click must not be called");
        },
        fill: async () => {
          calls.push("fill");
          throw new Error("fill must not be called");
        },
        press: async () => {
          calls.push("press");
          throw new Error("press must not be called");
        },
        setInputFiles: async () => {
          calls.push("setInputFiles");
          throw new Error("upload must not be called");
        },
      };
      return loc;
    };

    const page = {
      url: () => `https://jobright.ai/jobs/info/${STORED_ID}`,
      title: async () => "t",
      locator: (_sel: string) => makeLocator(null, false),
      getByRole: (_role: string, _opts?: { name?: RegExp }) =>
        makeLocator("Apply with Autofill", true),
    } as unknown as Page;

    const visibility = await inspectJobRightControlVisibility(page);
    expect(visibility.apply_with_autofill_visible).toBe(true);
    expect(calls).not.toContain("click");
    expect(calls).not.toContain("fill");
    expect(calls).not.toContain("press");
    expect(calls).not.toContain("setInputFiles");
  });

  it(
    "inspects a stored job absent from the feed via direct fixture navigation",
    async () => {
    const feedCards = parseJobCardsFromFeedHtml(
      fs.readFileSync(feedFixture, "utf8"),
    );
    expect(
      feedCards.some((c) => c.jobright_job_id === ABSENT_FROM_FEED_ID),
    ).toBe(false);

    const { db, applicationId } = seedJob({
      dbPath,
      artifactsDir,
      jobrightJobId: ABSENT_FROM_FEED_ID,
      company: "Amazon",
      role: "Software Development Engineer Internship - Fall 2026 (US)",
      jobUrl: `https://jobright.ai/jobs/info/${ABSENT_FROM_FEED_ID}`,
    });

    // Point fixture data attribute via temporary HTML copy with this id
    const tmpHtml = path.join(artifactsDir, "detail.html");
    fs.mkdirSync(artifactsDir, { recursive: true });
    const html = fs
      .readFileSync(detailFixture, "utf8")
      .replace(STORED_ID, ABSENT_FROM_FEED_ID);
    fs.writeFileSync(tmpHtml, html, "utf8");

    const appCountBefore = (
      db.prepare(`SELECT COUNT(*) AS n FROM applications`).get() as {
        n: number;
      }
    ).n;
    const stateBefore = (
      db
        .prepare(`SELECT state FROM applications WHERE id = ?`)
        .get(applicationId!) as { state: string }
    ).state;

    let report: StoredJobInspectionReport;
    try {
      report = await inspectStoredJobrightJob({
        jobrightJobId: ABSENT_FROM_FEED_ID,
        fixtureDetailHtmlPath: tmpHtml,
        headless: true,
        db,
      });
    } finally {
      closeDatabase(db);
    }

    expect(report.validation_level).toBe("FIXTURE_CONFIRMED");
    expect(report.mutation_attempted).toBe(false);
    expect(report.submit_attempted).toBe(false);
    expect(report.identity_verification?.passed).toBe(true);
    expect(report.stored_job.job_url).toContain(ABSENT_FROM_FEED_ID);
    expect(report.control_visibility?.improve_resume_visible).toBe(true);
    expect(report.artifact_path).toBeTruthy();
    expect(fs.existsSync(report.artifact_path!)).toBe(true);

    // Re-open db to verify no mutation of application rows
    const db2 = openDatabase(dbPath);
    try {
      const appCountAfter = (
        db2.prepare(`SELECT COUNT(*) AS n FROM applications`).get() as {
          n: number;
        }
      ).n;
      const stateAfter = (
        db2
          .prepare(`SELECT state FROM applications WHERE id = ?`)
          .get(applicationId!) as { state: string }
      ).state;
      expect(appCountAfter).toBe(appCountBefore);
      expect(stateAfter).toBe(stateBefore);
    } finally {
      closeDatabase(db2);
    }
  },
  30_000,
  );

  it(
    "fixture inspection of matching seeded job sets FIXTURE_CONFIRMED",
    async () => {
    const { db } = seedJob({
      dbPath,
      artifactsDir,
      jobrightJobId: STORED_ID,
      company: "Amazon",
      role: "Software Development Engineer Internship - Fall 2026 (US)",
    });
    try {
      const report = await inspectStoredJobrightJob({
        jobrightJobId: STORED_ID,
        fixtureDetailHtmlPath: detailFixture,
        headless: true,
        db,
      });
      expect(report.validation_level).toBe("FIXTURE_CONFIRMED");
      expect(report.mutation_attempted).toBe(false);
      expect(report.submit_attempted).toBe(false);
    } finally {
      closeDatabase(db);
    }
  },
  30_000,
  );
});
