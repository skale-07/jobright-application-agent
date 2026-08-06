import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PlaywrightServiceSession } from "../auth/serviceSession.js";
import { handleAuthExpiry } from "../auth/authExpiry.js";
import { detectAuthLossOnPage } from "../auth/authLossDetect.js";
import { getConfig, resetConfigCache } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { acquireLease, releaseLease } from "../queue/leases.js";
import { closeDatabase, migrate, openDatabase, type Db } from "../storage/db/client.js";
import { writeJsonAtomic } from "../storage/atomicJson.js";
import { hashJobDescription } from "../jobs/fingerprint.js";
import { waitForEnter } from "../util/stdin.js";
import {
  downloadAndVerifyResume,
  materialsDirForApplication,
  type ResumeDownloadResult,
} from "./resumeDownload.js";
import { getStoredJobInspectionTarget } from "./storedJobTarget.js";
import { probeResumeUi } from "./materials.js";

/**
 * Generating a resume mutates JobRight, so this is the inverse of the
 * read-only inspection guard: the operator must deliberately turn mutation on.
 */
export function assertResumeDownloadAllowed(reason: string): void {
  resetConfigCache();
  const cfg = getConfig();
  if (!cfg.materialsDownloadEnabled) {
    throw new Error(
      `MATERIALS_DOWNLOAD_ENABLED=false — refusing JobRight resume download (${reason}). ` +
        `This generates a resume on the live site. Set MATERIALS_DOWNLOAD_ENABLED=true and DRY_RUN=false to proceed.`,
    );
  }
  if (cfg.dryRun) {
    throw new Error(
      `DRY_RUN=true — refusing JobRight resume download (${reason}). Set DRY_RUN=false to execute.`,
    );
  }
  if (cfg.submitEnabled) {
    throw new Error(
      `SUBMIT_ENABLED=true — refusing JobRight resume download (${reason}). Submit must stay off for all Phase 5.6 work.`,
    );
  }
}

export type ResumeDownloadRunReport = {
  jobright_job_id: string;
  application_id: string | null;
  job_url: string | null;
  company: string | null;
  role: string | null;
  controls_visible: boolean | null;
  status: ResumeDownloadResult["status"] | "aborted";
  verified: boolean;
  path: string | null;
  sha256: string | null;
  size_bytes: number | null;
  idempotency_key: string | null;
  review_item_id: string | null;
  evidence: string;
  validation_level: "LIVE_MUTATION_CONFIRMED" | "UNVERIFIED";
  started_at: string;
  completed_at: string;
  artifact_path: string | null;
};

function baseReport(
  jobrightJobId: string,
  startedAt: string,
): ResumeDownloadRunReport {
  return {
    jobright_job_id: jobrightJobId,
    application_id: null,
    job_url: null,
    company: null,
    role: null,
    controls_visible: null,
    status: "aborted",
    verified: false,
    path: null,
    sha256: null,
    size_bytes: null,
    idempotency_key: null,
    review_item_id: null,
    evidence: "",
    validation_level: "UNVERIFIED",
    started_at: startedAt,
    completed_at: startedAt,
    artifact_path: null,
  };
}

/**
 * Human-initiated JobRight resume generate + download for one stored job.
 * Resolves the job from SQLite (no feed search), leases the application,
 * and delegates verification/persistence to downloadAndVerifyResume.
 */
export async function runJobrightResumeDownload(options: {
  jobrightJobId: string;
  headless?: boolean;
  /** Skip the interactive prompt. Operator asserts they initiated this run. */
  assumeYes?: boolean;
  baseResumeVersion?: string;
  db?: Db;
}): Promise<ResumeDownloadRunReport> {
  assertResumeDownloadAllowed("jobright.resume.download");

  const startedAt = new Date().toISOString();
  const report = baseReport(options.jobrightJobId, startedAt);
  const ownsDb = !options.db;
  const db = options.db ?? openDatabase();
  if (ownsDb) migrate(db);

  const runId = `resume-run-${randomUUID()}`;

  try {
    const resolved = getStoredJobInspectionTarget(db, options.jobrightJobId);
    if (!resolved.ok) {
      report.evidence = `${resolved.code}: ${resolved.message}`;
      return finish(report);
    }
    const target = resolved.target;
    report.application_id = target.applicationId;
    report.job_url = target.jobUrl;
    report.company = target.company;
    report.role = target.role;

    if (!target.applicationId) {
      report.evidence =
        "Stored job has no application row — run discovery before requesting materials";
      return finish(report);
    }

    if (!options.assumeYes) {
      console.log(`\nAbout to GENERATE A RESUME on live JobRight:`);
      console.log(`  job:     ${target.role ?? "?"} @ ${target.company ?? "?"}`);
      console.log(`  url:     ${target.jobUrl}`);
      console.log(`  app id:  ${target.applicationId}`);
      await waitForEnter("Press Enter to proceed, or Ctrl+C to abort... ");
    }

    acquireLease(db, {
      resourceType: "application",
      resourceId: `${target.applicationId}:materials`,
      holderRunId: runId,
      ttlMs: 180_000,
    });

    try {
      const session = new PlaywrightServiceSession({
        service: "jobright",
        headless: options.headless ?? false,
        slowMoMs: 50,
        acceptDownloads: true,
      });
      await session.open();
      const page = await session.newPage({ purpose: "resume_download" });
      try {
        await page.goto(target.jobUrl, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        await page.waitForTimeout(1500);

        if (await detectAuthLossOnPage(page, "jobright")) {
          handleAuthExpiry(db, {
            service: "jobright",
            detail: "Login wall during resume download",
          });
          report.evidence = "AUTH_REQUIRED: JobRight session expired";
          return finish(report);
        }

        const controls = await probeResumeUi(page);
        report.controls_visible = controls.improveResumeVisible;
        if (!controls.improveResumeVisible) {
          report.evidence =
            "Improve My Resume control not visible on this job — documented block, not a failure";
          return finish(report);
        }

        const downloadDir = materialsDirForApplication(target.applicationId);
        fs.mkdirSync(downloadDir, { recursive: true });

        const result = await downloadAndVerifyResume(page, {
          applicationId: target.applicationId,
          downloadDir,
          jobDescriptionHash: hashJobDescription(target.role ?? target.jobUrl),
          baseResumeVersion: options.baseResumeVersion ?? "v1",
          db,
          holderRunId: runId,
        });

        report.status = result.status;
        report.verified = result.verified;
        report.path = result.path ?? null;
        report.sha256 = result.sha256 ?? null;
        report.size_bytes = result.size_bytes ?? null;
        report.idempotency_key = result.idempotency_key;
        report.review_item_id = result.review_item_id ?? null;
        report.evidence = result.evidence;
        if (result.status === "downloaded" && result.verified) {
          report.validation_level = "LIVE_MUTATION_CONFIRMED";
        }
      } finally {
        await page.close().catch(() => undefined);
        await session.close();
      }
    } finally {
      releaseLease(db, {
        resourceType: "application",
        resourceId: `${target.applicationId}:materials`,
        holderRunId: runId,
      });
    }

    return finish(report);
  } finally {
    if (ownsDb) closeDatabase(db);
  }

  function finish(r: ResumeDownloadRunReport): ResumeDownloadRunReport {
    r.completed_at = new Date().toISOString();
    const out = path.join(
      getConfig().artifactsDir,
      "materials",
      `resume-run-${r.jobright_job_id}-${Date.now()}.json`,
    );
    fs.mkdirSync(path.dirname(out), { recursive: true });
    writeJsonAtomic(out, r);
    r.artifact_path = out;
    writeJsonAtomic(out, r);
    logger.info("jobright resume download run complete", {
      service: "jobright",
      action: "resume_download",
      metadata: {
        status: r.status,
        verified: r.verified,
        validation_level: r.validation_level,
      },
    });
    return r;
  }
}
