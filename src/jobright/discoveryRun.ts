import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { randomUUID } from "node:crypto";
import { getServiceAuthConfig } from "../auth/serviceRegistry.js";
import { requireStorageState } from "../auth/storageStateManager.js";
import { browserLaunchOptions } from "../browser/launchOptions.js";
import { getConfig } from "../config/index.js";
import { upsertJobByFingerprint } from "../jobs/repository.js";
import { hashJobDescription } from "../jobs/fingerprint.js";
import { logger } from "../logging/logger.js";
import { closeDatabase, migrate, openDatabase } from "../storage/db/client.js";
import {
  ensureApplicationArtifactDirs,
  writeJsonAtomic,
} from "../storage/atomicJson.js";
import {
  createApplication,
  transitionApplication,
} from "../queue/stateMachine.js";
import { defaultJobRightStartUrl } from "../recorder/workflows.js";
import { evaluateEligibility } from "./eligibility.js";
import { parseJobCardsFromFeedHtml, type ParsedJobCard } from "./jobFeed.js";
import { readJobDetailSnapshot } from "./jobDetails.js";
import { probeApplyLauncher } from "./applyLauncher.js";
import { probeCoverLetterUi, probeResumeUi } from "./materials.js";
import {
  JOBRIGHT_SELECTOR_REGISTRY_VERSION,
  jobrightSelectorsV1,
} from "./selectors/v1.js";

export type DiscoveryOptions = {
  /** If set, parse this HTML file instead of opening a browser. */
  feedHtmlPath?: string;
  maxJobs?: number;
  openJobDetails?: boolean;
  headless?: boolean;
};

export type DiscoveryReport = {
  selector_registry_version: number;
  feed_url: string;
  jobs_inspected: number;
  jobs_eligible: number;
  jobs_filtered_out: number;
  applications: Array<{
    application_id: string;
    jobright_job_id: string;
    company: string;
    role: string;
    eligible: boolean;
    state: string;
  }>;
};

/**
 * Phase 3 discovery: inspect JobRight feed + eligibility.
 * Does not open employer application forms or submit.
 */
export async function runJobRightDiscovery(
  options: DiscoveryOptions = {},
): Promise<DiscoveryReport> {
  const maxJobs = options.maxJobs ?? 10;
  const feedUrl = defaultJobRightStartUrl();
  const cards = options.feedHtmlPath
    ? parseJobCardsFromFeedHtml(fs.readFileSync(options.feedHtmlPath, "utf8")).slice(
        0,
        maxJobs,
      )
    : await scrapeFeedCardsLive({
        feedUrl,
        maxJobs,
        headless: options.headless ?? false,
      });

  const db = openDatabase();
  migrate(db);

  const report: DiscoveryReport = {
    selector_registry_version: JOBRIGHT_SELECTOR_REGISTRY_VERSION,
    feed_url: feedUrl,
    jobs_inspected: 0,
    jobs_eligible: 0,
    jobs_filtered_out: 0,
    applications: [],
  };

  try {
    for (const card of cards) {
      report.jobs_inspected += 1;
      const job = upsertJobByFingerprint(db, {
        jobrightJobId: card.jobright_job_id,
        applicationUrl: card.job_url,
        company: card.company,
        role: card.role,
        location: card.location,
        employmentType: card.employment_type,
        descriptionHash: hashJobDescription(card.role),
        raw: card,
      });

      const app = createApplication(db, {
        jobId: job.id,
        versions: {
          selector_registry_version: JOBRIGHT_SELECTOR_REGISTRY_VERSION,
          adapter: "jobright",
          adapter_version: 1,
        },
      });

      transitionApplication(db, {
        applicationId: app.id,
        nextState: "DUPLICATE_CHECK",
        reason: "phase3_discovery",
      });
      transitionApplication(db, {
        applicationId: app.id,
        nextState: "ELIGIBILITY_CHECK",
        reason: "phase3_discovery",
      });

      const eligibility = evaluateEligibility({
        role: card.role,
        employmentType: card.employment_type,
        description: card.role,
        alreadySubmitted: false,
      });

      const dirs = ensureApplicationArtifactDirs(app.id);
      writeJsonAtomic(path.join(dirs.root, "job.json"), {
        ...card,
        job_db_id: job.id,
      });
      writeJsonAtomic(path.join(dirs.root, "eligibility.json"), eligibility);

      if (!eligibility.eligible) {
        transitionApplication(db, {
          applicationId: app.id,
          nextState: "FILTERED_OUT",
          reason: "ineligible",
          route: "INELIGIBLE",
        });
        report.jobs_filtered_out += 1;
        report.applications.push({
          application_id: app.id,
          jobright_job_id: card.jobright_job_id,
          company: card.company,
          role: card.role,
          eligible: false,
          state: "FILTERED_OUT",
        });
        continue;
      }

      transitionApplication(db, {
        applicationId: app.id,
        nextState: "QUEUED",
        reason: "eligible",
      });
      report.jobs_eligible += 1;
      report.applications.push({
        application_id: app.id,
        jobright_job_id: card.jobright_job_id,
        company: card.company,
        role: card.role,
        eligible: true,
        state: "QUEUED",
      });
    }

    if (options.openJobDetails && !options.feedHtmlPath && cards[0]) {
      await probeFirstJobDetail(cards[0].job_url, options.headless ?? false);
    }
  } finally {
    closeDatabase(db);
  }

  logger.info("jobright discovery complete", {
    service: "jobright",
    action: "discovery",
    metadata: {
      inspected: report.jobs_inspected,
      eligible: report.jobs_eligible,
      filtered: report.jobs_filtered_out,
    },
  });

  return report;
}

async function scrapeFeedCardsLive(options: {
  feedUrl: string;
  maxJobs: number;
  headless: boolean;
}): Promise<ParsedJobCard[]> {
  const cfg = getServiceAuthConfig("jobright");
  requireStorageState(cfg.storageStatePath);
  const browser = await chromium.launch(
    browserLaunchOptions({ headless: options.headless, slowMoMs: 40 }),
  );
  const context = await browser.newContext({
    storageState: cfg.storageStatePath,
    viewport: cfg.viewport,
  });
  try {
    const page = await context.newPage();
    await page.goto(options.feedUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(2000);
    const html = await page.content();
    return parseJobCardsFromFeedHtml(html).slice(0, options.maxJobs);
  } finally {
    await context.close();
    await browser.close();
  }
}

async function probeFirstJobDetail(jobUrl: string, headless: boolean): Promise<void> {
  const cfg = getServiceAuthConfig("jobright");
  requireStorageState(cfg.storageStatePath);
  const browser = await chromium.launch(
    browserLaunchOptions({ headless, slowMoMs: 40 }),
  );
  const context = await browser.newContext({
    storageState: cfg.storageStatePath,
    viewport: cfg.viewport,
  });
  try {
    const page = await context.newPage();
    await page.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(1500);
    const detail = await readJobDetailSnapshot(page);
    const apply = await probeApplyLauncher(page);
    const resume = await probeResumeUi(page);
    const cover = await probeCoverLetterUi(page);
    const out = path.join(
      getConfig().artifactsDir,
      "discovery",
      `job-detail-probe-${randomUUID()}.json`,
    );
    fs.mkdirSync(path.dirname(out), { recursive: true });
    writeJsonAtomic(out, {
      detail,
      apply,
      resume,
      cover,
      selector_registry_version: JOBRIGHT_SELECTOR_REGISTRY_VERSION,
      selectors_note: jobrightSelectorsV1.contacts.note,
    });
    console.log(`Wrote job detail probe: ${out}`);
  } finally {
    await context.close();
    await browser.close();
  }
}

export async function inspectJobById(options: {
  jobId: string;
  feedHtmlPath?: string;
}): Promise<ParsedJobCard | null> {
  if (options.feedHtmlPath) {
    const cards = parseJobCardsFromFeedHtml(
      fs.readFileSync(options.feedHtmlPath, "utf8"),
    );
    return cards.find((c) => c.jobright_job_id === options.jobId) ?? null;
  }
  const cards = await scrapeFeedCardsLive({
    feedUrl: defaultJobRightStartUrl(),
    maxJobs: 40,
    headless: false,
  });
  return cards.find((c) => c.jobright_job_id === options.jobId) ?? null;
}
