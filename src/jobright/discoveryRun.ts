import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { PlaywrightServiceSession } from "../auth/serviceSession.js";
import { handleAuthExpiry } from "../auth/authExpiry.js";
import { getConfig } from "../config/index.js";
import {
  getOrCreateApplicationForJob,
  jobHasVerifiedSubmission,
  newDiscoveryRunId,
} from "../jobs/applicationDedupe.js";
import { upsertJobByFingerprint } from "../jobs/repository.js";
import { hashJobDescription } from "../jobs/fingerprint.js";
import { logger } from "../logging/logger.js";
import { closeDatabase, migrate, openDatabase, type Db } from "../storage/db/client.js";
import {
  ensureApplicationArtifactDirs,
  writeJsonAtomic,
} from "../storage/atomicJson.js";
import { transitionApplication } from "../queue/stateMachine.js";
import { acquireLease, releaseLease } from "../queue/leases.js";
import {
  buildIdempotencyKey,
  claimIdempotencyKey,
  completeIdempotencyKey,
} from "../queue/idempotency.js";
import { upsertOpenReviewItem } from "../queue/reviewItems.js";
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
import { detectAuthLossOnPage } from "../auth/authLossDetect.js";

export type DiscoveryOptions = {
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
  jobs_reused: number;
  jobs_skipped_submitted: number;
  applications: Array<{
    application_id: string;
    jobright_job_id: string;
    company: string;
    role: string;
    eligible: boolean;
    state: string;
    dedupe_kind: string;
  }>;
};

/**
 * JobRight feed discovery + eligibility. Idempotent per job for active applications.
 * Does not open employer forms or submit.
 */
export async function runJobRightDiscovery(
  options: DiscoveryOptions = {},
): Promise<DiscoveryReport> {
  const maxJobs = options.maxJobs ?? 10;
  const feedUrl = defaultJobRightStartUrl();
  const runId = newDiscoveryRunId();

  const cards = options.feedHtmlPath
    ? parseJobCardsFromFeedHtml(
        fs.readFileSync(options.feedHtmlPath, "utf8"),
      ).slice(0, maxJobs)
    : await scrapeFeedCardsLive({
        feedUrl,
        maxJobs,
        headless: options.headless ?? false,
        runId,
      });

  const db = openDatabase();
  migrate(db);

  const report: DiscoveryReport = {
    selector_registry_version: JOBRIGHT_SELECTOR_REGISTRY_VERSION,
    feed_url: feedUrl,
    jobs_inspected: 0,
    jobs_eligible: 0,
    jobs_filtered_out: 0,
    jobs_reused: 0,
    jobs_skipped_submitted: 0,
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

      const leaseKey = job.job_fingerprint;
      try {
        acquireLease(db, {
          resourceType: "job",
          resourceId: `${leaseKey}:discovery`,
          holderRunId: runId,
          ttlMs: 120_000,
        });
      } catch {
        report.applications.push({
          application_id: "",
          jobright_job_id: card.jobright_job_id,
          company: card.company,
          role: card.role,
          eligible: false,
          state: "LEASE_HELD",
          dedupe_kind: "LEASE_BLOCKED",
        });
        continue;
      }

      try {
        const idemKey = buildIdempotencyKey("discovery_enqueue", {
          job_fingerprint: job.job_fingerprint,
          generation: "active",
        });
        const claim = claimIdempotencyKey(db, idemKey, {
          holderRunId: runId,
          resourceType: "job",
          resourceId: job.id,
        });

        const dedupe = getOrCreateApplicationForJob(db, {
          jobId: job.id,
          versions: {
            selector_registry_version: JOBRIGHT_SELECTOR_REGISTRY_VERSION,
            adapter: "jobright",
            adapter_version: 1,
          },
        });

        if (
          dedupe.kind === "ALREADY_VERIFIED_SUBMITTED" ||
          dedupe.kind === "UNCERTAIN_SUBMISSION"
        ) {
          report.jobs_skipped_submitted += 1;
          if (claim.action === "execute") {
            completeIdempotencyKey(db, idemKey, dedupe.applicationId);
          }
          report.applications.push({
            application_id: dedupe.applicationId,
            jobright_job_id: card.jobright_job_id,
            company: card.company,
            role: card.role,
            eligible: false,
            state: dedupe.application.state,
            dedupe_kind: dedupe.kind,
          });
          continue;
        }

        if (dedupe.kind === "EXISTING_ACTIVE") {
          report.jobs_reused += 1;
          if (claim.action === "execute") {
            completeIdempotencyKey(db, idemKey, dedupe.applicationId);
          }
          const eligible = !["FILTERED_OUT"].includes(dedupe.application.state);
          if (eligible && dedupe.application.state === "QUEUED") {
            report.jobs_eligible += 1;
          }
          report.applications.push({
            application_id: dedupe.applicationId,
            jobright_job_id: card.jobright_job_id,
            company: card.company,
            role: card.role,
            eligible: dedupe.application.state === "QUEUED",
            state: dedupe.application.state,
            dedupe_kind: dedupe.kind,
          });
          continue;
        }

        // CREATED — run eligibility pipeline once
        const app = dedupe.application;
        transitionApplication(db, {
          applicationId: app.id,
          nextState: "DUPLICATE_CHECK",
          reason: "phase55_discovery_dedupe_pass",
        });

        const alreadySubmitted = jobHasVerifiedSubmission(db, job.id);

        transitionApplication(db, {
          applicationId: app.id,
          nextState: "ELIGIBILITY_CHECK",
          reason: "phase55_discovery",
        });

        const eligibility = evaluateEligibility({
          role: card.role,
          employmentType: card.employment_type,
          description: card.role,
          alreadySubmitted,
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
          completeIdempotencyKey(db, idemKey, app.id);
          report.applications.push({
            application_id: app.id,
            jobright_job_id: card.jobright_job_id,
            company: card.company,
            role: card.role,
            eligible: false,
            state: "FILTERED_OUT",
            dedupe_kind: dedupe.kind,
          });
          continue;
        }

        transitionApplication(db, {
          applicationId: app.id,
          nextState: "QUEUED",
          reason: "eligible",
        });
        completeIdempotencyKey(db, idemKey, app.id);
        report.jobs_eligible += 1;
        report.applications.push({
          application_id: app.id,
          jobright_job_id: card.jobright_job_id,
          company: card.company,
          role: card.role,
          eligible: true,
          state: "QUEUED",
          dedupe_kind: dedupe.kind,
        });
      } finally {
        releaseLease(db, {
          resourceType: "job",
          resourceId: `${leaseKey}:discovery`,
          holderRunId: runId,
        });
      }
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
      reused: report.jobs_reused,
      skipped_submitted: report.jobs_skipped_submitted,
    },
  });

  return report;
}

async function scrapeFeedCardsLive(options: {
  feedUrl: string;
  maxJobs: number;
  headless: boolean;
  runId: string;
}): Promise<ParsedJobCard[]> {
  const session = new PlaywrightServiceSession({
    service: "jobright",
    headless: options.headless,
    slowMoMs: 40,
  });
  const db = openDatabase();
  migrate(db);
  try {
    await session.open();
    const page = await session.newPage({ purpose: "jobright_feed" });
    try {
      await page.goto(options.feedUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      // Recommend feed is client-rendered. Prefer waiting for cards over a fixed sleep.
      // Timeout alone is not enough: parser can still return [] if href patterns drift.
      const cardsAttached = await page
        .waitForSelector(jobrightSelectorsV1.feed.jobInfoLinks, {
          timeout: 30_000,
          state: "attached",
        })
        .then(() => true)
        .catch(() => false);
      // No networkidle wait: this feed keeps connections open, so it never
      // settles and only costs the full timeout before being swallowed.
      await page.waitForTimeout(500);
      if (await detectAuthLossOnPage(page, "jobright")) {
        handleAuthExpiry(db, {
          service: "jobright",
          detail: "Login wall during JobRight feed scrape",
        });
        throw new Error("AUTH_REQUIRED: JobRight session expired during discovery");
      }
      const html = await page.content();
      const cards = parseJobCardsFromFeedHtml(html).slice(0, options.maxJobs);
      if (cards.length === 0) {
        await failLoudEmptyFeed(page, db, {
          feedUrl: options.feedUrl,
          cardsAttached,
          html,
          runId: options.runId,
        });
      }
      return cards;
    } finally {
      await page.close().catch(() => undefined);
    }
  } finally {
    await session.close();
    closeDatabase(db);
  }
}

export type EmptyFeedMeta = {
  feed_url: string;
  final_url: string;
  title: string;
  cards_selector_attached: boolean;
  html_bytes: number;
  html_path: string;
  screenshot_path: string;
  likely_cause: string;
  note: string;
};

/**
 * Pure evidence summary for an empty live feed.
 * `cards_selector_attached` is the discriminator: cards present but unparsed
 * means the parser drifted; cards absent means auth or render never happened.
 */
export function buildEmptyFeedMeta(input: {
  feedUrl: string;
  finalUrl: string;
  title: string;
  cardsAttached: boolean;
  htmlBytes: number;
  htmlPath: string;
  screenshotPath: string;
}): EmptyFeedMeta {
  return {
    feed_url: input.feedUrl,
    final_url: input.finalUrl,
    title: input.title,
    cards_selector_attached: input.cardsAttached,
    html_bytes: input.htmlBytes,
    html_path: input.htmlPath,
    screenshot_path: input.screenshotPath,
    likely_cause: input.cardsAttached
      ? "job card links rendered but parser matched none — selector/parser drift"
      : "no job card links ever rendered — session auth or feed render",
    note: "Live discovery parsed zero job cards — inspect artifacts before changing selectors",
  };
}

/**
 * Empty live feed must never look like success. Persist evidence and open a review item.
 */
async function failLoudEmptyFeed(
  page: Page,
  db: Db,
  input: {
    feedUrl: string;
    cardsAttached: boolean;
    html: string;
    runId: string;
  },
): Promise<never> {
  const dir = path.join(
    getConfig().artifactsDir,
    "discovery",
    `empty-feed-${input.runId}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  const htmlPath = path.join(dir, "page.html");
  const shotPath = path.join(dir, "page.png");
  const metaPath = path.join(dir, "meta.json");
  fs.writeFileSync(htmlPath, input.html, "utf8");
  await page.screenshot({ path: shotPath, fullPage: true }).catch(() => undefined);
  const meta = buildEmptyFeedMeta({
    feedUrl: input.feedUrl,
    finalUrl: page.url(),
    title: await page.title().catch(() => ""),
    cardsAttached: input.cardsAttached,
    htmlBytes: input.html.length,
    htmlPath,
    screenshotPath: shotPath,
  });
  writeJsonAtomic(metaPath, meta);

  const { item } = upsertOpenReviewItem(db, {
    kind: "MANUAL",
    title: "JobRight feed discovery returned zero cards",
    payload: meta,
  });

  logger.error("jobright live discovery empty feed", {
    service: "jobright",
    action: "discovery",
    metadata: { ...meta, review_item_id: item.id },
  });

  throw new Error(
    `EMPTY_FEED: JobRight live discovery found 0 job cards (selector_attached=${input.cardsAttached}). ` +
      `Artifacts: ${dir}. Review item: ${item.id}`,
  );
}

async function probeFirstJobDetail(
  jobUrl: string,
  headless: boolean,
): Promise<void> {
  const session = new PlaywrightServiceSession({
    service: "jobright",
    headless,
    slowMoMs: 40,
  });
  const db = openDatabase();
  migrate(db);
  try {
    await session.open();
    const page = await session.newPage({ purpose: "job_detail_probe" });
    try {
      await page.goto(jobUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForTimeout(1500);
      if (await detectAuthLossOnPage(page, "jobright")) {
        handleAuthExpiry(db, {
          service: "jobright",
          detail: "Login wall during JobRight job detail probe",
        });
        throw new Error("AUTH_REQUIRED: JobRight session expired during detail probe");
      }
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
      await page.close().catch(() => undefined);
    }
  } finally {
    await session.close();
    closeDatabase(db);
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
    runId: newDiscoveryRunId(),
  });
  return cards.find((c) => c.jobright_job_id === options.jobId) ?? null;
}
