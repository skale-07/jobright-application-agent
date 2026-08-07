import fs from "node:fs";
import { getConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import type { Db } from "../storage/db/client.js";
import type { ApplicationState } from "../queue/states.js";
import {
  getApplication,
  transitionApplication,
  type ApplicationRow,
} from "../queue/stateMachine.js";
import { acquireLease, releaseLease } from "../queue/leases.js";
import { listOpenReviewItems, upsertOpenReviewItem } from "../queue/reviewItems.js";
import { createAutomationRun, completeAutomationRun } from "../queue/automationRuns.js";
import { inspectApplicationHtml } from "../applications/applicationInspector.js";
import { openEssayReviewItem } from "../applications/essayAnswers.js";
import { runAtsFixtureFill } from "../applications/applicationFiller.js";
import { runAtsSubmission } from "../applications/submitRun.js";
import { runGreenhouseLiveFill } from "../ats/greenhouse/liveFill.js";
import { detectAtsFromUrl } from "../ats/shared/urlValidationDispatch.js";
import { getRegisteredResume } from "../jobright/materialsRegister.js";
import { withPublicUrlPage } from "../browser/fixtureSession.js";
import { describeSessionReadiness } from "../auth/serviceSession.js";
import { runContactsExtraction } from "../contacts/extractContacts.js";

export const MAX_ATTEMPTS = 3;

export type PipelineStop = "review" | "gate" | "terminal" | "submit_boundary";

export type PipelineStepLog = {
  from: ApplicationState;
  to: ApplicationState | null;
  note: string;
};

export type PipelineAppReport = {
  application_id: string;
  start_state: ApplicationState;
  end_state: ApplicationState;
  steps: PipelineStepLog[];
  stopped: PipelineStop | null;
  stop_reason: string | null;
};

export type PipelineReport = {
  run_id: string;
  applications: PipelineAppReport[];
};

export type PipelineOptions = {
  db: Db;
  applicationId?: string;
  maxApplications?: number;
  headless?: boolean;
  /** Fixture HTML path for the employer form — offline walk, no browser for inspect. */
  fixtureHtmlPath?: string;
  /** Delegate READY_TO_SUBMIT to the (fully gated) submission path. */
  submit?: boolean;
  /** Forwarded to runAtsSubmission for unattended runs. */
  assumeYes?: boolean;
  /** Fixture HTML for the contacts page — offline post-submit walk. */
  contactsFixtureHtmlPath?: string;
};

/** States the sequential driver can pick up and advance. */
const ADVANCEABLE: ApplicationState[] = [
  "QUEUED",
  "MATERIALS_GENERATING",
  "RESUME_DOWNLOADED",
  "APPLICATION_OPENING",
  "ATS_DETECTION",
  "APPLICATION_INSPECTION",
  "NATIVE_AUTOFILL_RUNNING",
  "FIELD_VERIFICATION",
  "READY_TO_SUBMIT",
  "SUBMITTED",
  "CONTACTS_EXTRACTED",
  "EMAIL_GENERATED",
];

export function getEmployerApplicationUrl(
  db: Db,
  applicationId: string,
): string | null {
  const row = db
    .prepare(
      `SELECT j.raw_json FROM jobs j
       JOIN applications a ON a.job_id = j.id WHERE a.id = ?`,
    )
    .get(applicationId) as { raw_json: string } | undefined;
  if (!row) return null;
  const raw = JSON.parse(row.raw_json) as Record<string, unknown>;
  const url = raw["employer_application_url"];
  return typeof url === "string" && url.length > 0 ? url : null;
}

/** Persist the employer ATS URL on the job so submit and re-runs find it. */
export function setEmployerApplicationUrl(
  db: Db,
  applicationId: string,
  url: string,
): void {
  const detected = detectAtsFromUrl(url);
  if (detected.ats === null) {
    throw new Error(`Refusing to store employer URL: ${detected.failureReason}`);
  }
  const row = db
    .prepare(
      `SELECT j.id, j.raw_json FROM jobs j
       JOIN applications a ON a.job_id = j.id WHERE a.id = ?`,
    )
    .get(applicationId) as { id: string; raw_json: string } | undefined;
  if (!row) throw new Error(`Unknown application: ${applicationId}`);
  const raw = JSON.parse(row.raw_json) as Record<string, unknown>;
  raw["employer_application_url"] = detected.normalizedUrl;
  raw["employer_application_ats"] = detected.ats;
  db.prepare(`UPDATE jobs SET raw_json = ?, updated_at = ? WHERE id = ?`).run(
    JSON.stringify(raw),
    new Date().toISOString(),
    row.id,
  );
}

type StepContext = {
  db: Db;
  app: ApplicationRow;
  runId: string;
  options: PipelineOptions;
};

type StepOutcome = {
  to: ApplicationState | null;
  note: string;
  stop?: PipelineStop;
};

async function fetchEmployerPageHtml(
  ctx: StepContext,
  url: string,
): Promise<{ html: string; finalUrl: string; title: string }> {
  if (ctx.options.fixtureHtmlPath) {
    return {
      html: fs.readFileSync(ctx.options.fixtureHtmlPath, "utf8"),
      finalUrl: url,
      title: "fixture",
    };
  }
  return withPublicUrlPage(
    url,
    async (page) => ({
      html: await page.content(),
      finalUrl: page.url(),
      title: await page.title().catch(() => ""),
    }),
    { headless: ctx.options.headless ?? true },
  );
}

/**
 * Sequential single-application pipeline driver. No daemon, no parallelism:
 * one app, one lease, one step at a time. Every stop leaves the application
 * in a state the CLI surfaces (report/dashboard) with a review item when
 * human input is what unblocks it.
 */
export async function runPipeline(
  options: PipelineOptions,
): Promise<PipelineReport> {
  const { db } = options;
  // application_events.run_id references automation_runs(id): the run row IS
  // the run id used for transitions.
  const automationRun = createAutomationRun(db, { stage: "pipeline" });
  const runId = automationRun.id;

  const candidates = options.applicationId
    ? [options.applicationId]
    : (
        db
          .prepare(
            `SELECT id FROM applications
             WHERE state IN (${ADVANCEABLE.map(() => "?").join(",")})
             ORDER BY created_at ASC LIMIT ?`,
          )
          .all(...ADVANCEABLE, options.maxApplications ?? 1) as Array<{
          id: string;
        }>
      ).map((r) => r.id);

  const report: PipelineReport = { run_id: runId, applications: [] };

  try {
    for (const applicationId of candidates) {
      report.applications.push(
        await runOneApplication({ db, applicationId, runId, options, automationRunId: automationRun.id }),
      );
    }
  } finally {
    completeAutomationRun(db, automationRun.id);
  }

  logger.info("pipeline run complete", {
    service: "pipeline",
    action: "run",
    metadata: {
      run_id: runId,
      applications: report.applications.length,
    },
  });
  return report;
}

async function runOneApplication(input: {
  db: Db;
  applicationId: string;
  runId: string;
  options: PipelineOptions;
  automationRunId: string;
}): Promise<PipelineAppReport> {
  const { db, applicationId, runId, options } = input;
  const first = getApplication(db, applicationId);
  if (!first) {
    return {
      application_id: applicationId,
      start_state: "FAILED_FINAL",
      end_state: "FAILED_FINAL",
      steps: [],
      stopped: "terminal",
      stop_reason: `Unknown application: ${applicationId}`,
    };
  }

  const appReport: PipelineAppReport = {
    application_id: applicationId,
    start_state: first.state,
    end_state: first.state,
    steps: [],
    stopped: null,
    stop_reason: null,
  };

  acquireLease(db, {
    resourceType: "application",
    resourceId: `${applicationId}:pipeline`,
    holderRunId: runId,
    ttlMs: 600_000,
  });

  try {
    // Bounded loop: every iteration must transition or stop.
    for (let i = 0; i < 25; i++) {
      const app = getApplication(db, applicationId);
      if (!app) break;
      appReport.end_state = app.state;

      // A human owns anything with an open review item.
      const openItems = listOpenReviewItems(db).filter(
        (it) => it.application_id === applicationId,
      );
      if (openItems.length > 0) {
        appReport.stopped = "review";
        appReport.stop_reason = `open review item: ${openItems[0]?.kind} — ${openItems[0]?.title}`;
        break;
      }

      if (!ADVANCEABLE.includes(app.state)) {
        appReport.stopped = "terminal";
        appReport.stop_reason = `state ${app.state} is not pipeline-advanceable`;
        break;
      }

      const outcome = await step({ db, app, runId, options }, input.automationRunId);
      appReport.steps.push({
        from: app.state,
        to: outcome.to,
        note: outcome.note,
      });
      if (outcome.to) {
        appReport.end_state = outcome.to;
      }
      if (outcome.stop) {
        appReport.stopped = outcome.stop;
        appReport.stop_reason = outcome.note;
        break;
      }
    }
  } finally {
    releaseLease(db, {
      resourceType: "application",
      resourceId: `${applicationId}:pipeline`,
      holderRunId: runId,
    });
  }

  const finalApp = getApplication(db, applicationId);
  if (finalApp) appReport.end_state = finalApp.state;
  return appReport;
}

async function step(
  ctx: StepContext,
  automationRunId: string,
): Promise<StepOutcome> {
  const { db, app, runId } = ctx;
  const cfg = getConfig();

  switch (app.state) {
    case "QUEUED": {
      transitionApplication(db, {
        applicationId: app.id,
        nextState: "MATERIALS_GENERATING",
        reason: "pipeline: materials stage",
        runId,
      });
      return { to: "MATERIALS_GENERATING", note: "materials stage entered" };
    }

    case "MATERIALS_GENERATING": {
      const resume = getRegisteredResume(db, app.id);
      if (!resume) {
        upsertOpenReviewItem(db, {
          applicationId: app.id,
          kind: "MANUAL",
          title: "Resume material not registered",
          payload: {
            hint: `npm run materials:register -- --application ${app.id} --file <domain-resume.pdf>`,
          },
        });
        return {
          to: null,
          note: "no verified resume material — register one (materials:register)",
          stop: "review",
        };
      }
      transitionApplication(db, {
        applicationId: app.id,
        nextState: "RESUME_DOWNLOADED",
        reason: `pipeline: verified resume present (sha256 ${resume.sha256.slice(0, 12)})`,
        runId,
      });
      return { to: "RESUME_DOWNLOADED", note: "verified resume material found" };
    }

    case "RESUME_DOWNLOADED": {
      transitionApplication(db, {
        applicationId: app.id,
        nextState: "APPLICATION_OPENING",
        reason: "pipeline: open employer application",
        runId,
      });
      return { to: "APPLICATION_OPENING", note: "opening employer application" };
    }

    case "APPLICATION_OPENING": {
      const url = getEmployerApplicationUrl(db, app.id);
      if (!url) {
        upsertOpenReviewItem(db, {
          applicationId: app.id,
          kind: "MANUAL",
          title: "Employer application URL unknown",
          payload: {
            hint: `npm run run -- --pipeline --app ${app.id} --url <GREENHOUSE_APPLICATION_URL>`,
          },
        });
        return {
          to: null,
          note: "employer application URL not stored for this job",
          stop: "review",
        };
      }
      const detected = detectAtsFromUrl(url);
      if (detected.ats === null) {
        transitionApplication(db, {
          applicationId: app.id,
          nextState: "UNSUPPORTED_ATS",
          reason: `pipeline: employer URL not a supported ATS (${detected.failureReason})`,
          runId,
          route: "UNSUPPORTED_ATS",
        });
        upsertOpenReviewItem(db, {
          applicationId: app.id,
          kind: "UNSUPPORTED_ATS",
          title: "Employer ATS unsupported in V1",
          payload: { url, reason: detected.failureReason },
        });
        return { to: "UNSUPPORTED_ATS", note: "unsupported ATS", stop: "review" };
      }
      transitionApplication(db, {
        applicationId: app.id,
        nextState: "ATS_DETECTION",
        reason: `pipeline: ${detected.ats} URL validated`,
        runId,
      });
      return { to: "ATS_DETECTION", note: `${detected.ats} URL validated` };
    }

    case "ATS_DETECTION": {
      transitionApplication(db, {
        applicationId: app.id,
        nextState: "APPLICATION_INSPECTION",
        reason: "pipeline: inspect employer form",
        runId,
      });
      return { to: "APPLICATION_INSPECTION", note: "inspection stage entered" };
    }

    case "APPLICATION_INSPECTION": {
      const url = getEmployerApplicationUrl(db, app.id) ?? "https://fixture.local/";
      const page = await fetchEmployerPageHtml(ctx, url);
      const inspect = await inspectApplicationHtml({
        url: page.finalUrl,
        html: page.html,
        title: page.title,
      });

      switch (inspect.route) {
        case "needs_human_captcha":
          transitionApplication(db, {
            applicationId: app.id,
            nextState: "CAPTCHA_REQUIRED",
            reason: "pipeline: blocking CAPTCHA on employer form",
            runId,
            route: "CAPTCHA_REQUIRED",
          });
          upsertOpenReviewItem(db, {
            applicationId: app.id,
            kind: "CAPTCHA_REQUIRED",
            title: "Blocking CAPTCHA on employer form",
            payload: { url: page.finalUrl },
          });
          return { to: "CAPTCHA_REQUIRED", note: "blocking captcha", stop: "review" };
        case "needs_login":
        case "needs_account_creation":
          transitionApplication(db, {
            applicationId: app.id,
            nextState: "AUTH_REQUIRED",
            reason: `pipeline: ${inspect.route}`,
            runId,
            route: "AUTH_REQUIRED",
          });
          upsertOpenReviewItem(db, {
            applicationId: app.id,
            kind: "AUTH_REQUIRED",
            title: "Employer form requires login/account",
            payload: { url: page.finalUrl, route: inspect.route },
          });
          return { to: "AUTH_REQUIRED", note: inspect.route, stop: "review" };
        case "skip_unsupported_ats":
          transitionApplication(db, {
            applicationId: app.id,
            nextState: "UNSUPPORTED_ATS",
            reason: "pipeline: detected unsupported ATS markers",
            runId,
            route: "UNSUPPORTED_ATS",
          });
          upsertOpenReviewItem(db, {
            applicationId: app.id,
            kind: "UNSUPPORTED_ATS",
            title: "Employer ATS unsupported in V1",
            payload: { url: page.finalUrl },
          });
          return { to: "UNSUPPORTED_ATS", note: "unsupported ATS", stop: "review" };
        case "needs_essay": {
          transitionApplication(db, {
            applicationId: app.id,
            nextState: "ESSAY_REQUIRED",
            reason: "pipeline: human essays required",
            runId,
            route: "ESSAY_REQUIRED",
          });
          openEssayReviewItem(db, {
            applicationId: app.id,
            fields: inspect.inspection.fields,
          });
          return {
            to: "ESSAY_REQUIRED",
            note: "essays required — write them via resume-essay",
            stop: "review",
          };
        }
        default:
          transitionApplication(db, {
            applicationId: app.id,
            nextState: "NATIVE_AUTOFILL_RUNNING",
            reason: `pipeline: inspection route ${inspect.route}`,
            runId,
          });
          return {
            to: "NATIVE_AUTOFILL_RUNNING",
            note: `route ${inspect.route} — proceeding to deterministic fill`,
          };
      }
    }

    case "NATIVE_AUTOFILL_RUNNING": {
      if (!cfg.formFillEnabled || cfg.dryRun) {
        return {
          to: null,
          note: "fill gate closed (FORM_FILL_ENABLED/DRY_RUN) — set flags to proceed",
          stop: "gate",
        };
      }
      let verifyPassed = false;
      let detail = "";
      if (ctx.options.fixtureHtmlPath) {
        const fillReport = await runAtsFixtureFill("greenhouse", {
          execute: true,
          includeHumanEssays: { db, applicationId: app.id },
        });
        verifyPassed = fillReport.verify?.passed === true;
        detail = `fixture fill: ${fillReport.fill?.filled.length ?? 0} filled`;
      } else {
        const url = getEmployerApplicationUrl(db, app.id);
        if (!url) {
          return { to: null, note: "employer URL missing at fill stage", stop: "gate" };
        }
        const detected = detectAtsFromUrl(url);
        if (detected.ats === null) {
          return {
            to: null,
            note: `employer URL no longer validates: ${detected.failureReason}`,
            stop: "gate",
          };
        }
        if (detected.ats !== "greenhouse") {
          // Replaced by the shared guarded live fill in the next milestone.
          return {
            to: null,
            note: `${detected.ats} live fill not yet wired — fixture-mode only for now`,
            stop: "gate",
          };
        }
        const liveReport = await runGreenhouseLiveFill({
          url,
          execute: true,
          headless: ctx.options.headless ?? false,
        });
        verifyPassed = liveReport.verify?.passed === true;
        detail = `live fill: ${liveReport.fill?.filled.length ?? 0} filled`;
      }

      transitionApplication(db, {
        applicationId: app.id,
        nextState: "FIELD_VERIFICATION",
        reason: `pipeline: fill executed (${detail})`,
        runId,
      });
      if (!verifyPassed) {
        transitionApplication(db, {
          applicationId: app.id,
          nextState: "AMBIGUOUS_FIELD",
          reason: "pipeline: read-back verification failed",
          runId,
          route: "AMBIGUOUS_FIELD",
        });
        upsertOpenReviewItem(db, {
          applicationId: app.id,
          kind: "AMBIGUOUS_FIELD",
          title: "Fill verification failed",
          payload: { detail },
        });
        return { to: "AMBIGUOUS_FIELD", note: "verification failed", stop: "review" };
      }
      transitionApplication(db, {
        applicationId: app.id,
        nextState: "READY_TO_SUBMIT",
        reason: "pipeline: fill rehearsal verified",
        runId,
      });
      return { to: "READY_TO_SUBMIT", note: `verified (${detail})` };
    }

    case "FIELD_VERIFICATION": {
      // Reached via the essay path (resume-essay). The binding pre-click
      // verification happens inside runAtsSubmission on the live page;
      // this stage records readiness only.
      transitionApplication(db, {
        applicationId: app.id,
        nextState: "READY_TO_SUBMIT",
        reason:
          "pipeline: essays complete — final verification occurs pre-click in submit",
        runId,
      });
      return { to: "READY_TO_SUBMIT", note: "essays complete" };
    }

    case "READY_TO_SUBMIT": {
      if (!ctx.options.submit) {
        return {
          to: null,
          note: "ready — submission requires explicit `submit` command or --submit",
          stop: "submit_boundary",
        };
      }
      const result = await runAtsSubmission({
        db,
        applicationId: app.id,
        headless: ctx.options.headless ?? false,
        assumeYes: ctx.options.assumeYes ?? false,
        automationRunId,
      });
      if (result.outcome !== "SUBMITTED_VERIFIED") {
        return {
          to: null,
          note: `submission not verified: ${result.outcome} — ${result.reason}`,
          stop: result.outcome === "UNCERTAIN" ? "review" : "gate",
        };
      }
      return { to: "SUBMITTED", note: "submission verified" };
    }

    case "SUBMITTED": {
      // Post-submit: contact extraction needs a JobRight session (or a
      // fixture). When neither is available, complete rather than fail —
      // the operator can run contacts:extract manually later is NOT possible
      // once COMPLETED, so we stop instead when a session might exist.
      const readiness = describeSessionReadiness("jobright", "STORAGE_STATE");
      if (!ctx.options.contactsFixtureHtmlPath && !readiness.ready) {
        transitionApplication(db, {
          applicationId: app.id,
          nextState: "COMPLETED",
          reason: "pipeline: no jobright session for contacts — completing",
          runId,
        });
        return {
          to: "COMPLETED",
          note: "completed (no jobright session for contact extraction)",
        };
      }
      const contactsReport = await runContactsExtraction({
        db,
        applicationId: app.id,
        ...(ctx.options.contactsFixtureHtmlPath
          ? { fixtureHtmlPath: ctx.options.contactsFixtureHtmlPath }
          : {}),
        headless: ctx.options.headless ?? true,
      });
      return {
        to: contactsReport.end_state as ApplicationState,
        note: `contacts extracted: ${contactsReport.extracted}`,
      };
    }

    case "CONTACTS_EXTRACTED": {
      if (!cfg.emailGenerationEnabled || !cfg.openaiApiKey) {
        transitionApplication(db, {
          applicationId: app.id,
          nextState: "COMPLETED",
          reason: "pipeline: outreach generation disabled — completing",
          runId,
        });
        return {
          to: "COMPLETED",
          note: "completed (EMAIL_GENERATION_ENABLED off — run email:generate manually if desired)",
        };
      }
      return {
        to: null,
        note: "outreach generation runs via email:generate (per-contact, operator-reviewed)",
        stop: "gate",
      };
    }

    case "EMAIL_GENERATED": {
      // Draft creation (M6) is operator-driven via draft:create; the pipeline
      // completes here. The Outlook Drafts folder is the review surface.
      if (!cfg.outlookDraftsEnabled) {
        transitionApplication(db, {
          applicationId: app.id,
          nextState: "COMPLETED",
          reason: "pipeline: drafts disabled — completing",
          runId,
        });
        return { to: "COMPLETED", note: "completed (OUTLOOK_DRAFTS_ENABLED off)" };
      }
      return {
        to: null,
        note: "validated email ready — create the draft via draft:create",
        stop: "gate",
      };
    }

    default:
      return {
        to: null,
        note: `no handler for state ${app.state}`,
        stop: "terminal",
      };
  }
}

/**
 * Re-queue FAILED_RETRYABLE applications with an attempt cap. Beyond the cap
 * the application is finalized rather than silently retried forever.
 */
export function retryFailedApplications(
  db: Db,
  options: { maxAttempts?: number } = {},
): Array<{ application_id: string; action: "requeued" | "finalized"; attempt: number }> {
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const rows = db
    .prepare(`SELECT id, attempt FROM applications WHERE state = 'FAILED_RETRYABLE'`)
    .all() as Array<{ id: string; attempt: number }>;

  const results: Array<{
    application_id: string;
    action: "requeued" | "finalized";
    attempt: number;
  }> = [];
  for (const row of rows) {
    if (row.attempt >= maxAttempts) {
      transitionApplication(db, {
        applicationId: row.id,
        nextState: "FAILED_FINAL",
        reason: `retry cap reached (${row.attempt}/${maxAttempts})`,
      });
      results.push({
        application_id: row.id,
        action: "finalized",
        attempt: row.attempt,
      });
      continue;
    }
    transitionApplication(db, {
      applicationId: row.id,
      nextState: "QUEUED",
      reason: `retry ${row.attempt + 1}/${maxAttempts}`,
      attempt: row.attempt + 1,
    });
    results.push({
      application_id: row.id,
      action: "requeued",
      attempt: row.attempt + 1,
    });
  }
  return results;
}
