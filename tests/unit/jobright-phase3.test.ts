import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { parseJobCardsFromFeedHtml } from "../../src/jobright/jobFeed.js";
import { evaluateEligibility } from "../../src/jobright/eligibility.js";
import { verifyPdfDownload } from "../../src/jobright/jobDetails.js";
import { detectCoverLetterState } from "../../src/jobright/materials.js";
import { JOBRIGHT_SELECTOR_REGISTRY_VERSION } from "../../src/jobright/selectors/v1.js";
import {
  buildEmptyFeedMeta,
  runJobRightDiscovery,
} from "../../src/jobright/discoveryRun.js";
import { resetConfigCache } from "../../src/config/index.js";

const feedFixture = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "jobright",
  "job-feed",
  "dom.sanitized.html",
);

describe("jobright phase3", () => {
  it("exposes selector registry version 2", () => {
    expect(JOBRIGHT_SELECTOR_REGISTRY_VERSION).toBe(2);
  });

  it("parses job cards from captured feed HTML", () => {
    const html = fs.readFileSync(feedFixture, "utf8");
    const cards = parseJobCardsFromFeedHtml(html);
    expect(cards.length).toBeGreaterThan(3);
    expect(cards[0]?.jobright_job_id).toMatch(/^[a-f0-9]+$/i);
    expect(cards[0]?.job_url).toContain("/jobs/info/");
    expect(cards.some((c) => /intern/i.test(c.role))).toBe(true);
    expect(cards.some((c) => c.company.length > 1)).toBe(true);
  });

  it("evaluates internship eligibility without ranking", () => {
    const ok = evaluateEligibility({
      role: "Software Engineering Intern",
      employmentType: "Internship",
      description: "Currently pursuing a bachelor's degree",
    });
    expect(ok.eligible).toBe(true);
    expect(ok.checks.find((c) => c.name === "internship")?.result).toBe(true);

    const bad = evaluateEligibility({
      role: "Staff Software Engineer",
      employmentType: "Full-time",
      description: "Requires 5+ years of professional experience. PhD only.",
    });
    expect(bad.eligible).toBe(false);
  });

  it("verifies PDF downloads by magic bytes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-pdf-"));
    const good = path.join(dir, "resume.pdf");
    fs.writeFileSync(good, Buffer.from("%PDF-1.4\n%fake\n"));
    const v = verifyPdfDownload(good);
    expect(v.verified).toBe(true);
    expect(v.sha256.length).toBe(64);

    const bad = path.join(dir, "not-resume.bin");
    fs.writeFileSync(bad, Buffer.from("not-a-pdf"));
    expect(verifyPdfDownload(bad).verified).toBe(false);
  });

  it("detects cover letter UI states", () => {
    expect(
      detectCoverLetterState({ copyButtonVisible: true, editorVisible: false }),
    ).toBe("GENERATED");
    expect(
      detectCoverLetterState({
        copyButtonVisible: false,
        editorVisible: false,
        requiredByPolicy: true,
      }),
    ).toBe("REQUIRED");
  });
});

describe("empty live feed evidence (UNIT_CONFIRMED)", () => {
  const base = {
    feedUrl: "https://jobright.ai/jobs/recommend",
    finalUrl: "https://jobright.ai/jobs/recommend",
    title: "Jobright",
    htmlBytes: 1234,
    htmlPath: "/artifacts/discovery/empty-feed-x/page.html",
    screenshotPath: "/artifacts/discovery/empty-feed-x/page.png",
  };

  it("blames parser drift when card links rendered but none parsed", () => {
    const meta = buildEmptyFeedMeta({ ...base, cardsAttached: true });
    expect(meta.cards_selector_attached).toBe(true);
    expect(meta.likely_cause).toMatch(/parser drift/i);
  });

  it("blames auth or render when no card links ever appeared", () => {
    const meta = buildEmptyFeedMeta({ ...base, cardsAttached: false });
    expect(meta.cards_selector_attached).toBe(false);
    expect(meta.likely_cause).toMatch(/auth or feed render/i);
  });

  it("carries artifact paths so the failure is diagnosable", () => {
    const meta = buildEmptyFeedMeta({ ...base, cardsAttached: false });
    expect(meta.html_path).toBe(base.htmlPath);
    expect(meta.screenshot_path).toBe(base.screenshotPath);
    expect(meta.html_bytes).toBe(1234);
    expect(meta.feed_url).toBe(base.feedUrl);
  });
});

describe("discovery from fixture", () => {
  let dbPath: string;

  beforeEach(() => {
    resetConfigCache();
    dbPath = path.join(os.tmpdir(), `jaa-disc-${randomUUID()}.sqlite`);
    process.env.DATABASE_PATH = dbPath;
    process.env.ARTIFACTS_DIR = path.join(os.tmpdir(), `jaa-art-${randomUUID()}`);
  });

  afterEach(() => {
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it("queues eligible jobs from fixture HTML into sqlite", async () => {
    const report = await runJobRightDiscovery({
      feedHtmlPath: feedFixture,
      maxJobs: 5,
    });
    expect(report.selector_registry_version).toBe(2);
    expect(report.jobs_inspected).toBeGreaterThan(0);
    expect(report.jobs_eligible + report.jobs_filtered_out).toBe(
      report.jobs_inspected,
    );
    expect(report.applications.length).toBe(report.jobs_inspected);
  });
});
