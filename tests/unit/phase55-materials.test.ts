import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { chromium, type Browser } from "playwright";
import { browserLaunchOptions } from "../../src/browser/launchOptions.js";
import { resetConfigCache } from "../../src/config/index.js";
import { closeDatabase, migrate, openDatabase } from "../../src/storage/db/client.js";
import { createApplication } from "../../src/queue/stateMachine.js";
import { getIdempotency } from "../../src/queue/idempotency.js";
import { listOpenReviewItems } from "../../src/queue/reviewItems.js";
import {
  downloadAndVerifyResume,
  resumeIdempotencyKey,
  saveVerifiedResume,
  verifyResumePdfBuffer,
} from "../../src/jobright/resumeDownload.js";
import { SYNTHETIC_RESUME_BYTES } from "../../src/security/artifactScan.js";
import { promoteFixture } from "../../src/recorder/promoteFixture.js";
import {
  writeCaptureBundle,
  type CaptureBundle,
} from "../../src/recorder/captureWriter.js";
import { pathToFileURL } from "node:url";

function seedApplication(dbPath: string, artifactsDir: string): {
  applicationId: string;
  db: ReturnType<typeof openDatabase>;
} {
  process.env.DATABASE_PATH = dbPath;
  process.env.ARTIFACTS_DIR = artifactsDir;
  resetConfigCache();
  const db = openDatabase(dbPath);
  migrate(db);
  const jobId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO jobs (
      id, company, role, job_fingerprint, raw_json, created_at, updated_at
    ) VALUES (?, 'Acme', 'Intern', ?, '{}', ?, ?)`,
  ).run(jobId, `fp-${jobId}`, now, now);
  const app = createApplication(db, { jobId });
  return { applicationId: app.id, db };
}

describe("phase55 materials — verify/save/persist", () => {
  let dbPath: string;
  let artifactsDir: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `jaa-m55-${randomUUID()}.sqlite`);
    artifactsDir = path.join(os.tmpdir(), `jaa-art55-${randomUUID()}`);
  });

  afterEach(() => {
    resetConfigCache();
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it("rejects buffers without %PDF- magic", () => {
    const v = verifyResumePdfBuffer(Buffer.from("not-a-pdf"));
    expect(v.verified).toBe(false);
  });

  it("saves verified synthetic PDF atomically and upserts materials", () => {
    const { applicationId, db } = seedApplication(dbPath, artifactsDir);
    try {
      const saved = saveVerifiedResume({
        db,
        applicationId,
        pdfBytes: SYNTHETIC_RESUME_BYTES,
      });
      expect(saved.verification.verified).toBe(true);
      expect(fs.existsSync(saved.path)).toBe(true);
      expect(saved.path).toContain(
        path.join("applications", applicationId, "materials"),
      );
      expect(path.basename(saved.path)).toMatch(/^resume-[a-f0-9]{8}\.pdf$/);

      const row = db
        .prepare(
          `SELECT * FROM materials WHERE application_id = ? AND kind = 'resume'`,
        )
        .get(applicationId) as {
        path: string;
        sha256: string;
        verified: number;
      };
      expect(row.verified).toBe(1);
      expect(row.sha256).toBe(saved.sha256);
      expect(row.path).toBe(saved.path);

      // upsert
      const again = saveVerifiedResume({
        db,
        applicationId,
        pdfBytes: SYNTHETIC_RESUME_BYTES,
      });
      const count = db
        .prepare(
          `SELECT COUNT(*) AS n FROM materials WHERE application_id = ? AND kind = 'resume'`,
        )
        .get(applicationId) as { n: number };
      expect(count.n).toBe(1);
      expect(again.sha256).toBe(saved.sha256);
    } finally {
      closeDatabase(db);
    }
  });
});

describe("phase55 materials — playwright download fixture", () => {
  let browser: Browser;
  let dbPath: string;
  let artifactsDir: string;

  beforeAll(async () => {
    browser = await chromium.launch(
      browserLaunchOptions({ headless: true, channel: "chromium", slowMoMs: 0 }),
    );
  });

  afterAll(async () => {
    await browser.close();
  });

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `jaa-dl55-${randomUUID()}.sqlite`);
    artifactsDir = path.join(os.tmpdir(), `jaa-dlart55-${randomUUID()}`);
  });

  afterEach(() => {
    resetConfigCache();
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it("downloads via local HTML fixture and persists resume", async () => {
    const { applicationId, db } = seedApplication(dbPath, artifactsDir);
    const downloadDir = path.join(artifactsDir, "downloads");
    const fixtureHtml = path.join(
      process.cwd(),
      "tests",
      "fixtures",
      "jobright",
      "resume-download",
      "download.html",
    );
    const page = await browser.newPage();
    try {
      await page.goto(pathToFileURL(fixtureHtml).href);
      const result = await downloadAndVerifyResume(page, {
        applicationId,
        downloadDir,
        jobDescriptionHash: "jdhash-test",
        baseResumeVersion: "v1",
        db,
      });
      expect(result.status).toBe("downloaded");
      expect(result.verified).toBe(true);
      expect(result.path).toBeTruthy();
      expect(fs.existsSync(result.path!)).toBe(true);
      expect(result.idempotency_key).toBe(
        resumeIdempotencyKey({
          applicationId,
          jobDescriptionHash: "jdhash-test",
          baseResumeVersion: "v1",
        }),
      );
      const idem = getIdempotency(db, result.idempotency_key);
      expect(idem?.status).toBe("completed");

      const skipped = await downloadAndVerifyResume(page, {
        applicationId,
        downloadDir,
        jobDescriptionHash: "jdhash-test",
        baseResumeVersion: "v1",
        db,
      });
      expect(skipped.status).toBe("skipped");
    } finally {
      await page.close();
      closeDatabase(db);
    }
  });

  it("creates review item when download control is missing", async () => {
    const { applicationId, db } = seedApplication(dbPath, artifactsDir);
    const page = await browser.newPage();
    try {
      await page.setContent("<html><body><p>no resume button</p></body></html>");
      const result = await downloadAndVerifyResume(page, {
        applicationId,
        downloadDir: path.join(artifactsDir, "downloads"),
        jobDescriptionHash: "jdhash-fail",
        baseResumeVersion: "v1",
        db,
      });
      expect(result.status).toBe("failed");
      expect(result.review_item_id).toBeTruthy();
      const open = listOpenReviewItems(db);
      expect(open.some((r) => r.title === "Resume download failed")).toBe(true);
    } finally {
      await page.close();
      closeDatabase(db);
    }
  });
});

describe("phase55 recorder promote", () => {
  it("promotes sanitized capture, excludes screenshots, refuses overwrite", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-promo-"));
    const capturesRoot = path.join(root, "fixtures", "live-captures");
    const fixturesRoot = path.join(root, "tests", "fixtures", "jobright");
    const runId = "promo-run-1";

    const bundle: CaptureBundle = {
      workflow: "job-feed",
      runId,
      capturedAt: "2026-07-18T00:00:00.000Z",
      url: "https://jobright.ai/jobs/recommend",
      title: "Recommended Jobs",
      domHtml: "<html><body><a href='/jobs/info/abc'>Apply</a></body></html>",
      a11yText: 'link "Apply"',
      labels: [{ tag: "a", role: null, text: "Apply" }],
      iframes: [],
      network: [{ url: "https://jobright.ai/api", headers: { Accept: "json" } }],
      pages: [{ url: "https://jobright.ai/jobs/recommend", title: "Jobs" }],
      downloads: [],
      routeLog: [
        {
          at: "2026-07-18T00:00:00.000Z",
          url: "https://jobright.ai/jobs/recommend",
          kind: "goto",
        },
      ],
      screenshotPng: Buffer.from("89504e470d0a1a0a", "hex"),
    };
    writeCaptureBundle(bundle, capturesRoot);

    const dbPath = path.join(root, "promo.sqlite");
    process.env.DATABASE_PATH = dbPath;
    resetConfigCache();
    const db = openDatabase(dbPath);
    migrate(db);

    try {
      const first = promoteFixture({
        runId,
        workflow: "job-feed",
        liveCapturesRoot: capturesRoot,
        fixturesRoot,
        db,
      });
      expect(first.status).toBe("promoted");
      expect(first.copied).toContain("dom.sanitized.html");
      expect(first.copied).not.toContain("screenshot.png");
      expect(
        fs.existsSync(path.join(first.outDir, "screenshot.png")),
      ).toBe(false);
      expect(fs.existsSync(path.join(first.outDir, "promote-meta.json"))).toBe(
        true,
      );

      const second = promoteFixture({
        runId,
        workflow: "job-feed",
        liveCapturesRoot: capturesRoot,
        fixturesRoot,
        db,
      });
      expect(second.status).toBe("skipped");

      // New run id, refuse overwrite without --force
      const run2 = "promo-run-2";
      writeCaptureBundle({ ...bundle, runId: run2 }, capturesRoot);
      const refused = promoteFixture({
        runId: run2,
        workflow: "job-feed",
        liveCapturesRoot: capturesRoot,
        fixturesRoot,
        db,
      });
      expect(refused.status).toBe("failed");
      expect(refused.evidence).toMatch(/Refuse overwrite/);

      const forced = promoteFixture({
        runId: run2,
        workflow: "job-feed",
        liveCapturesRoot: capturesRoot,
        fixturesRoot,
        force: true,
        db,
      });
      expect(forced.status).toBe("promoted");
    } finally {
      closeDatabase(db);
      resetConfigCache();
    }
  });

  it("rejects raw captures path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-raw-"));
    const rawRoot = path.join(root, "fixtures", "raw-captures");
    const result = promoteFixture({
      runId: "x",
      workflow: "job-feed",
      liveCapturesRoot: rawRoot,
      fixturesRoot: path.join(root, "out"),
    });
    expect(result.status).toBe("failed");
  });
});
