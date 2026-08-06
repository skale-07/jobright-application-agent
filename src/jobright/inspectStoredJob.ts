import fs from "node:fs";
import path from "node:path";
import { type Page } from "playwright";
import { PlaywrightServiceSession } from "../auth/serviceSession.js";
import { detectAuthLossOnPage } from "../auth/authLossDetect.js";
import { withFixtureHtmlPage } from "../browser/fixtureSession.js";
import { assertReadOnlyInspectionAllowed } from "../applications/readOnlyInspectionGuards.js";
import { getConfig } from "../config/index.js";
import { redactObject } from "../logging/redaction.js";
import { upsertOpenReviewItem } from "../queue/reviewItems.js";
import { writeJsonAtomic } from "../storage/atomicJson.js";
import { closeDatabase, migrate, openDatabase, type Db } from "../storage/db/client.js";
import {
  inspectJobRightControlVisibility,
  readVisibleJobIdentity,
  type JobRightControlVisibility,
} from "./controlVisibility.js";
import {
  verifyJobIdentity,
  type JobIdentityVerification,
} from "./jobIdentityVerification.js";
import { JOBRIGHT_SELECTOR_REGISTRY_VERSION } from "./selectors/v1.js";
import {
  getStoredJobInspectionTarget,
  getStoredJobInspectionTargetByApplicationId,
  type StoredJobInspectionTarget,
} from "./storedJobTarget.js";

export type InspectionValidationLevel =
  | "LIVE_READ_ONLY_CONFIRMED"
  | "FIXTURE_CONFIRMED"
  | "UNVERIFIED";

export type StoredJobInspectionReport = {
  validation_level: InspectionValidationLevel;
  requested_jobright_job_id: string;
  application_id: string | null;
  stored_job: {
    job_db_id: string;
    jobright_job_id: string;
    job_url: string;
    job_path: string | null;
    company: string | null;
    role: string | null;
    application_state: string | null;
  };
  final_url: string | null;
  identity_verification: JobIdentityVerification | null;
  authentication_status: string;
  control_visibility: JobRightControlVisibility | null;
  selector_registry_version: number;
  warnings: string[];
  inspection_started_at: string;
  inspection_completed_at: string;
  mutation_attempted: false;
  submit_attempted: false;
  artifact_path: string | null;
  diagnostics?: Record<string, unknown>;
  error: string | null;
};

export class StoredJobInspectionError extends Error {
  readonly exitCode: number;
  readonly report: StoredJobInspectionReport;

  constructor(message: string, exitCode: number, report: StoredJobInspectionReport) {
    super(message);
    this.name = "StoredJobInspectionError";
    this.exitCode = exitCode;
    this.report = report;
  }
}

function assertReadOnlyInspectionFlags(): void {
  assertReadOnlyInspectionAllowed("JobRight stored-job inspection");
}

function artifactPathFor(jobrightJobId: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(
    getConfig().artifactsDir,
    "inspection",
    `jobright-inspect-${jobrightJobId}-${ts}.json`,
  );
}

function baseReport(
  target: StoredJobInspectionTarget | null,
  requestedId: string,
  started: string,
): StoredJobInspectionReport {
  return {
    validation_level: "UNVERIFIED",
    requested_jobright_job_id: requestedId,
    application_id: target?.applicationId ?? null,
    stored_job: {
      job_db_id: target?.jobDbId ?? "",
      jobright_job_id: target?.jobrightJobId ?? requestedId,
      job_url: target?.jobUrl ?? "",
      job_path: target?.jobPath ?? null,
      company: target?.company ?? null,
      role: target?.role ?? null,
      application_state: target?.applicationState ?? null,
    },
    final_url: null,
    identity_verification: null,
    authentication_status: "NOT_STARTED",
    control_visibility: null,
    selector_registry_version: JOBRIGHT_SELECTOR_REGISTRY_VERSION,
    warnings: [],
    inspection_started_at: started,
    inspection_completed_at: started,
    mutation_attempted: false,
    submit_attempted: false,
    artifact_path: null,
    error: null,
  };
}

function writeArtifact(report: StoredJobInspectionReport): string {
  const out = artifactPathFor(report.requested_jobright_job_id);
  // Set path before serialize so persisted JSON matches CLI output
  report.artifact_path = out;
  const sanitized = redactObject(
    report as unknown as Record<string, unknown>,
  );
  writeJsonAtomic(out, sanitized);
  return out;
}

async function recordAuthRequired(
  db: Db,
  detail: string,
  applicationId: string | null,
): Promise<void> {
  // Review only — do not transition application state during inspection
  upsertOpenReviewItem(db, {
    ...(applicationId ? { applicationId } : {}),
    kind: "AUTH_REQUIRED",
    title: "jobright authentication required",
    payload: {
      service: "jobright",
      detail,
      source: "inspect_stored_job",
      checked_at: new Date().toISOString(),
    },
  });
}

async function runPageInspection(input: {
  page: Page;
  target: StoredJobInspectionTarget;
  report: StoredJobInspectionReport;
  fixtureMode: boolean;
  saveDiagnostics: boolean;
}): Promise<void> {
  const { page, target, report, fixtureMode, saveDiagnostics } = input;

  const identityBits = await readVisibleJobIdentity(page);
  report.final_url = identityBits.finalUrl;

  // Fixture file:// pages use data-jobright-job-id
  const parsedId =
    identityBits.parsedJobrightJobId ??
    (fixtureMode ? target.jobrightJobId : null);

  const identity = verifyJobIdentity({
    requestedJobrightJobId: target.jobrightJobId,
    finalUrl: identityBits.finalUrl,
    parsedJobrightJobId: fixtureMode
      ? identityBits.parsedJobrightJobId ?? target.jobrightJobId
      : parsedId,
    storedCompany: target.company,
    visibleCompany: identityBits.visibleCompany,
    storedRole: target.role,
    visibleRole: identityBits.visibleRole,
  });

  // Fixture setContent pages (about:blank) use data-jobright-job-id.
  // Override redirect classifier which rejects non-JobRight hosts.
  if (fixtureMode && !identityBits.finalUrl.includes("/jobs/info/")) {
    const idOk =
      (identityBits.parsedJobrightJobId ?? target.jobrightJobId).toLowerCase() ===
      target.jobrightJobId.toLowerCase();
    if (!idOk) {
      report.identity_verification = {
        ...identity,
        passed: false,
        failureReason: identity.failureReason ?? "Fixture job id mismatch",
      };
      report.validation_level = "UNVERIFIED";
      report.error = "JobRight identity verification failed.";
      return;
    }
    const fixed = verifyJobIdentity({
      requestedJobrightJobId: target.jobrightJobId,
      finalUrl: target.jobUrl,
      parsedJobrightJobId: target.jobrightJobId,
      storedCompany: target.company,
      visibleCompany: identityBits.visibleCompany,
      storedRole: target.role,
      visibleRole: identityBits.visibleRole,
    });
    report.identity_verification = {
      ...fixed,
      finalUrl: identityBits.finalUrl,
    };
    if (!fixed.passed) {
      report.validation_level = "UNVERIFIED";
      report.error = "JobRight identity verification failed.";
      return;
    }
  } else {
    report.identity_verification = identity;
    if (!identity.passed) {
      report.validation_level = "UNVERIFIED";
      report.error = "JobRight identity verification failed.";
      return;
    }
  }

  report.warnings.push(
    ...(report.identity_verification?.warnings ?? []),
  );

  const controls = await inspectJobRightControlVisibility(page);
  report.control_visibility = controls;

  if (controls.captcha_visible) {
    report.validation_level = "UNVERIFIED";
    report.error = "CAPTCHA detected — inspection aborted";
    report.warnings.push("captcha_visible");
    return;
  }
  if (controls.login_wall_visible) {
    report.validation_level = "UNVERIFIED";
    report.error = "Login wall visible — inspection aborted";
    return;
  }
  if (controls.external_apply_visible) {
    report.warnings.push(
      "External ATS link visible on JobRight page (not opened)",
    );
  }

  if (saveDiagnostics) {
    report.diagnostics = {
      page_title: identityBits.pageTitle,
      match_counts: Object.fromEntries(
        Object.entries(controls.details).map(([k, v]) => [k, v.match_count]),
      ),
      final_url_safe: fixtureMode
        ? "[FIXTURE_FILE]"
        : identityBits.finalUrl.replace(/\?.*$/, ""),
    };
  }

  report.validation_level = fixtureMode
    ? "FIXTURE_CONFIRMED"
    : "LIVE_READ_ONLY_CONFIRMED";
  report.error = null;
}

/**
 * Deterministic read-only inspection of a stored JobRight job.
 * Navigates directly to the persisted detail URL — does not scrape the feed.
 */
export async function inspectStoredJobrightJob(options: {
  jobrightJobId?: string;
  applicationId?: string;
  /** Local HTML fixture — skips live JobRight / PlaywrightServiceSession auth */
  fixtureDetailHtmlPath?: string;
  headless?: boolean;
  saveDiagnostics?: boolean;
  db?: Db;
}): Promise<StoredJobInspectionReport> {
  assertReadOnlyInspectionFlags();

  const started = new Date().toISOString();
  const ownsDb = !options.db;
  const db = options.db ?? openDatabase();
  if (ownsDb) migrate(db);

  const fixtureMode = Boolean(options.fixtureDetailHtmlPath);
  let report = baseReport(null, options.jobrightJobId ?? "", started);

  try {
    if (!options.jobrightJobId && !options.applicationId) {
      report.error = "Provide --job <jobright_job_id> or --application <uuid>";
      report.inspection_completed_at = new Date().toISOString();
      writeArtifact(report);
      throw new StoredJobInspectionError(report.error, 1, report);
    }
    if (options.jobrightJobId && options.applicationId) {
      report.error = "Provide only one of --job or --application";
      report.inspection_completed_at = new Date().toISOString();
      writeArtifact(report);
      throw new StoredJobInspectionError(report.error, 1, report);
    }

    const resolved = options.applicationId
      ? getStoredJobInspectionTargetByApplicationId(db, options.applicationId)
      : getStoredJobInspectionTarget(db, options.jobrightJobId!);

    if (!resolved.ok) {
      report = baseReport(null, options.jobrightJobId ?? options.applicationId!, started);
      report.error =
        resolved.code === "NOT_FOUND"
          ? `${resolved.message}\nRun discovery first or verify the job ID.`
          : resolved.message;
      report.inspection_completed_at = new Date().toISOString();
      writeArtifact(report);
      throw new StoredJobInspectionError(
        resolved.code === "NOT_FOUND"
          ? `Stored JobRight job not found: ${options.jobrightJobId ?? options.applicationId}`
          : resolved.message,
        1,
        report,
      );
    }

    const target = resolved.target;
    report = baseReport(target, target.jobrightJobId, started);

    // Count applications before — must not create
    const appCountBefore = (
      db.prepare(`SELECT COUNT(*) AS n FROM applications`).get() as { n: number }
    ).n;
    const stateBefore = target.applicationId
      ? (
          db
            .prepare(`SELECT state FROM applications WHERE id = ?`)
            .get(target.applicationId) as { state: string } | undefined
        )?.state
      : null;

    if (fixtureMode) {
      const htmlPath = options.fixtureDetailHtmlPath!;
      if (!fs.existsSync(htmlPath)) {
        report.error = `Fixture HTML not found: ${htmlPath}`;
        report.inspection_completed_at = new Date().toISOString();
        writeArtifact(report);
        throw new StoredJobInspectionError(report.error, 1, report);
      }
      report.authentication_status = "FIXTURE_SKIPPED";
      const html = fs.readFileSync(htmlPath, "utf8");
      await withFixtureHtmlPage(html, async (page) => {
        await runPageInspection({
          page,
          target,
          report,
          fixtureMode: true,
          saveDiagnostics: Boolean(options.saveDiagnostics),
        });
      });
    } else {
      const session = new PlaywrightServiceSession({
        service: "jobright",
        headless: options.headless ?? false,
        slowMoMs: 40,
      });
      try {
        await session.open();
        report.authentication_status = "AUTHENTICATED";
        const page = await session.newPage({
          purpose: "stored_job_inspection",
        });
        try {
          await page.goto(target.jobUrl, {
            waitUntil: "domcontentloaded",
            timeout: 60_000,
          });
          await page.waitForTimeout(1500);

          if (await detectAuthLossOnPage(page, "jobright")) {
            report.authentication_status = "AUTH_REQUIRED";
            await recordAuthRequired(
              db,
              "Login wall during stored JobRight job inspection",
              target.applicationId,
            );
            report.validation_level = "UNVERIFIED";
            report.error = "Authentication lost during inspection";
            report.final_url = page.url();
            report.inspection_completed_at = new Date().toISOString();
            writeArtifact(report);
            throw new StoredJobInspectionError(report.error, 1, report);
          }

          await runPageInspection({
            page,
            target,
            report,
            fixtureMode: false,
            saveDiagnostics: Boolean(options.saveDiagnostics),
          });

          if (report.error) {
            report.inspection_completed_at = new Date().toISOString();
            writeArtifact(report);
            throw new StoredJobInspectionError(report.error, 1, report);
          }
        } finally {
          await page.close().catch(() => undefined);
        }
      } finally {
        await session.close();
      }
    }

    const appCountAfter = (
      db.prepare(`SELECT COUNT(*) AS n FROM applications`).get() as { n: number }
    ).n;
    if (appCountAfter !== appCountBefore) {
      report.warnings.push("UNEXPECTED: application count changed during inspection");
    }
    if (target.applicationId && stateBefore) {
      const stateAfter = (
        db
          .prepare(`SELECT state FROM applications WHERE id = ?`)
          .get(target.applicationId) as { state: string }
      ).state;
      if (stateAfter !== stateBefore) {
        report.warnings.push(
          `UNEXPECTED: application state changed ${stateBefore} → ${stateAfter}`,
        );
      }
    }

    report.inspection_completed_at = new Date().toISOString();
    writeArtifact(report);

    if (report.error || report.validation_level === "UNVERIFIED") {
      throw new StoredJobInspectionError(
        report.error ?? "Inspection incomplete",
        1,
        report,
      );
    }

    return report;
  } finally {
    if (ownsDb) closeDatabase(db);
  }
}

export function formatInspectionConsole(report: StoredJobInspectionReport): string {
  const cv = report.control_visibility;
  const lines = [
    `JobRight inspection: ${report.validation_level}`,
    `Requested job ID: ${report.requested_jobright_job_id}`,
    `Stored company: ${report.stored_job.company ?? "(none)"}`,
    `Stored role: ${report.stored_job.role ?? "(none)"}`,
    `Final URL: ${report.final_url ?? "(none)"}`,
    `Identity verified: ${report.identity_verification?.passed ?? false}`,
    `Standard Apply visible: ${cv?.standard_apply_visible ?? false}`,
    `Apply with Autofill visible: ${cv?.apply_with_autofill_visible ?? false}`,
    `Any apply control visible: ${cv?.any_apply_control_visible ?? false}`,
    `External apply/ATS link visible: ${cv?.external_apply_visible ?? false}`,
    `Improve resume visible: ${cv?.improve_resume_visible ?? false}`,
    `Resume download visible: ${cv?.resume_download_visible ?? false}`,
    `Mutation attempted: ${report.mutation_attempted}`,
    `Submit attempted: ${report.submit_attempted}`,
    `Artifact: ${report.artifact_path ?? "(none)"}`,
  ];
  return lines.join("\n");
}
