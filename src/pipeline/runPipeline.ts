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
import { essayFieldsOnly } from "../applications/essayDetector.js";
import { runAtsFixtureFill } from "../applications/applicationFiller.js";
import { runAtsSubmission } from "../applications/submitRun.js";
import type { ConfirmSubmission } from "../applications/submitConfirmation.js";
import { runGreenhouseLiveFill } from "../ats/greenhouse/liveFill.js";
import { runAtsLiveFill } from "../applications/atsLiveFill.js";
import {
  probeCdpEndpoint,
  runNavigation,
  type NavigationReport,
  type RunNavigationInput,
} from "../navigation/runNavigation.js";
import { PlaywrightServiceSession } from "../auth/serviceSession.js";
import type { Page } from "playwright";
import { ATS_BINDINGS } from "../applications/atsBindings.js";
import { detectAtsFromUrl } from "../ats/shared/urlValidationDispatch.js";
import {
  ensureResumeForApplication,
  getRegisteredResume,
} from "../jobright/materialsRegister.js";
import { withPublicUrlPage } from "../browser/fixtureSession.js";
import { describeSessionReadiness } from "../auth/serviceSession.js";
import { runContactsExtraction } from "../contacts/extractContacts.js";
import {
  printOperatorFieldBrief,
  type OperatorFieldBrief,
} from "../applications/operatorFieldBrief.js";

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
  /** Confirmation transport forwarded to runAtsSubmission (web modal seam). */
  confirmSubmission?: ConfirmSubmission;
  /** Fixture HTML for the contacts page — offline post-submit walk. */
  contactsFixtureHtmlPath?: string;
  /**
   * Test seam: force JobRight session readiness for the contacts step.
   * Production always asks describeSessionReadiness.
   */
  jobrightContactsReady?: boolean;
  /** Test seam: replaces runNavigation for offline pipeline tests. */
  navigationRunner?: (input: RunNavigationInput) => Promise<NavigationReport>;
  /**
   * Shared automation run to attribute this walk to instead of minting a
   * fresh one. The L3 worker passes its arm-session row here so every
   * submit across every app in the session consumes from the ONE arm
   * budget (not a per-app cap). When set, the caller owns the row's
   * lifecycle — runPipeline neither creates nor completes it.
   */
  automationRunId?: string;
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

export {
  getEmployerApplicationUrl,
  setEmployerApplicationUrl,
} from "../applications/employerUrl.js";
import {
  getEmployerApplicationUrl,
  setEmployerApplicationUrl,
} from "../applications/employerUrl.js";

type StepContext = {
  db: Db;
  app: ApplicationRow;
  runId: string;
  options: PipelineOptions;
};

/**
 * Route a navigation run that ended on a wall into the state machine.
 * jobright_auth already got its review item + AUTH_REQUIRED transition via
 * handleAuthExpiry inside runNavigation.
 */
function routeNavigationWall(
  db: Db,
  applicationId: string,
  nav: NavigationReport,
  runId: string,
): StepOutcome {
  switch (nav.wall) {
    case "jobright_auth":
      return {
        to: null,
        note: "JobRight authentication required for navigation",
        stop: "review",
      };
    case "auth":
    case "phone_otp": {
      upsertOpenReviewItem(db, {
        applicationId,
        kind: "MANUAL",
        title: "Navigation blocked by employer identity wall",
        payload: {
          wall: nav.wall,
          nav_run_id: nav.run_id,
          report_path: nav.report_path ?? null,
        },
      });
      return { to: null, note: `navigation blocked: ${nav.wall}`, stop: "review" };
    }
    case "captcha": {
      transitionApplication(db, {
        applicationId,
        nextState: "CAPTCHA_REQUIRED",
        reason: "navigation: blocking CAPTCHA on the employer path",
        runId,
        route: "CAPTCHA_REQUIRED",
      });
      upsertOpenReviewItem(db, {
        applicationId,
        kind: "CAPTCHA_REQUIRED",
        title: "Navigation blocked by CAPTCHA",
        payload: { nav_run_id: nav.run_id },
      });
      return { to: "CAPTCHA_REQUIRED", note: "navigation captcha", stop: "review" };
    }
    default: {
      transitionApplication(db, {
        applicationId,
        nextState: "FAILED_RETRYABLE",
        reason: `navigation unresolved (${nav.wall})`,
        runId,
      });
      return {
        to: "FAILED_RETRYABLE",
        note: `navigation unresolved: ${nav.wall}`,
        stop: "review",
      };
    }
  }
}

type StepOutcome = {
  to: ApplicationState | null;
  note: string;
  stop?: PipelineStop;
};

/** nav_session recorded by storeResolvedEmployerUrl ("cdp" | "ephemeral"). */
function getNavSessionKind(db: Db, applicationId: string): string | null {
  const row = db
    .prepare(
      `SELECT j.raw_json FROM jobs j
       JOIN applications a ON a.job_id = j.id WHERE a.id = ?`,
    )
    .get(applicationId) as { raw_json: string } | undefined;
  if (!row) return null;
  const raw = JSON.parse(row.raw_json) as Record<string, unknown>;
  return typeof raw["nav_session"] === "string"
    ? (raw["nav_session"] as string)
    : null;
}

/**
 * Session handoff (nav N6): when navigation ran in the operator's CDP
 * Chrome, attach to the same Chrome so employer cookies survive into
 * inspection/fill. Nobody owns that Chrome: this attaches, hands the
 * caller a page, and disconnects — falling back to the ephemeral path on
 * any unreachable/attach error.
 */
async function withNavHandoffPage<T>(
  ctx: StepContext,
  fn: (page: Page | null) => Promise<T>,
): Promise<T> {
  const cfg = getConfig();
  const kind = getNavSessionKind(ctx.db, ctx.app.id);
  if (kind !== "cdp" || !(await probeCdpEndpoint(cfg.agentCdpUrl))) {
    return fn(null);
  }
  // The catch guards ONLY attach/open/newPage — an error thrown by the
  // caller's work must propagate, never silently re-run on the ephemeral
  // path (a live fill re-executed twice would double-mutate the form).
  let session: PlaywrightServiceSession | null = null;
  let page: Page | null = null;
  try {
    session = new PlaywrightServiceSession({
      service: "jobright",
      mode: "CDP_ATTACH",
      skipAuthValidation: true,
    });
    await session.open();
    page = await session.newPage({ purpose: "nav-handoff" });
  } catch {
    if (session) await session.close().catch(() => undefined);
    session = null;
    page = null;
  }
  if (!page) return fn(null);
  try {
    return await fn(page);
  } finally {
    if (session) await session.close().catch(() => undefined);
  }
}

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
  return withNavHandoffPage(ctx, async (handoff) => {
    if (handoff) {
      await handoff.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      return {
        html: await handoff.content(),
        finalUrl: handoff.url(),
        title: await handoff.title().catch(() => ""),
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
  });
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
  // the run id used for transitions. A caller-supplied automationRunId (the
  // L3 worker's arm row) is used verbatim and NOT completed here; otherwise
  // we mint and complete our own row.
  const ownsRun = !options.automationRunId;
  const runId =
    options.automationRunId ?? createAutomationRun(db, { stage: "pipeline" }).id;

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
        await runOneApplication({ db, applicationId, runId, options, automationRunId: runId }),
      );
    }
  } finally {
    if (ownsRun) completeAutomationRun(db, runId);
  }

  logger.info("pipeline run complete", {
    service: "pipeline",
    action: "run",
    metadata: {
      run_id: runId,
      applications: report.applications.length,
      results: report.applications.map((a) => ({
        application_id: a.application_id,
        start_state: a.start_state,
        end_state: a.end_state,
        stopped: a.stopped,
        stop_reason: a.stop_reason,
        steps: a.steps.map((s) => `${s.from}→${s.to ?? "stop"}: ${s.note}`),
      })),
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

  logger.info("pipeline app begin", {
    service: "pipeline",
    action: "app_begin",
    application_id: applicationId,
    metadata: {
      run_id: runId,
      start_state: first.state,
      headless: options.headless ?? true,
      submit_opt_in: options.submit === true,
      has_employer_url: Boolean(getEmployerApplicationUrl(db, applicationId)),
      fixture: Boolean(options.fixtureHtmlPath),
    },
  });

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
        logger.warn("pipeline stopped: open review", {
          service: "pipeline",
          action: "stop_review",
          application_id: applicationId,
          metadata: {
            state: app.state,
            review_kind: openItems[0]?.kind,
            review_title: openItems[0]?.title,
            review_id: openItems[0]?.id,
          },
        });
        break;
      }

      if (!ADVANCEABLE.includes(app.state)) {
        appReport.stopped = "terminal";
        appReport.stop_reason = `state ${app.state} is not pipeline-advanceable`;
        logger.info("pipeline stopped: non-advanceable state", {
          service: "pipeline",
          action: "stop_terminal",
          application_id: applicationId,
          metadata: { state: app.state },
        });
        break;
      }

      logger.info(`pipeline step: ${app.state}`, {
        service: "pipeline",
        action: "step_enter",
        application_id: applicationId,
        metadata: {
          run_id: runId,
          iteration: i,
          state: app.state,
          employer_url: getEmployerApplicationUrl(db, applicationId),
        },
      });

      let outcome: StepOutcome;
      try {
        outcome = await step({ db, app, runId, options }, input.automationRunId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        logger.error("pipeline step threw", {
          service: "pipeline",
          action: "step_error",
          application_id: applicationId,
          metadata: {
            state: app.state,
            error: message.slice(0, 500),
            stack: stack?.split("\n").slice(0, 8).join(" | "),
          },
        });
        throw err;
      }

      appReport.steps.push({
        from: app.state,
        to: outcome.to,
        note: outcome.note,
      });
      if (outcome.to) {
        appReport.end_state = outcome.to;
      }

      logger.info(`pipeline step done: ${app.state}`, {
        service: "pipeline",
        action: "step_exit",
        application_id: applicationId,
        metadata: {
          from: app.state,
          to: outcome.to,
          note: outcome.note,
          stop: outcome.stop ?? null,
        },
      });

      if (outcome.stop) {
        appReport.stopped = outcome.stop;
        appReport.stop_reason = outcome.note;
        const level = outcome.stop === "gate" || outcome.stop === "review" ? "warn" : "info";
        logger[level](`pipeline stop: ${outcome.stop}`, {
          service: "pipeline",
          action: "stop",
          application_id: applicationId,
          metadata: {
            stop: outcome.stop,
            stop_reason: outcome.note,
            last_state: app.state,
            next_state: outcome.to,
          },
        });
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

  logger.info("pipeline app end", {
    service: "pipeline",
    action: "app_end",
    application_id: applicationId,
    metadata: {
      run_id: runId,
      start_state: appReport.start_state,
      end_state: appReport.end_state,
      stopped: appReport.stopped,
      stop_reason: appReport.stop_reason,
      step_count: appReport.steps.length,
      steps: appReport.steps.map((s) => `${s.from}→${s.to ?? "—"} (${s.note})`),
    },
  });
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
      // Auto-attach the configured default resume before giving up — so an
      // unattended session processing a freshly discovered app is not
      // dead-ended by a sticky review item. No-op when one is already
      // registered; loud when there is no default file to fall back to.
      ensureResumeForApplication(db, app.id);
      const resume = getRegisteredResume(db, app.id);
      if (!resume) {
        upsertOpenReviewItem(db, {
          applicationId: app.id,
          kind: "MANUAL",
          title: "Resume material not registered",
          payload: {
            hint: `Register one (materials:register) or set DEFAULT_RESUME_PATH; app ${app.id}`,
          },
        });
        return {
          to: null,
          note: "no verified resume material and no default resume to auto-attach",
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
        if (cfg.navigationEnabled) {
          const nav = await (ctx.options.navigationRunner ?? runNavigation)({
            db,
            applicationId: app.id,
            headless: ctx.options.headless ?? true,
          });
          if (nav.resolved_url) {
            // Stored by runNavigation; the next iteration of this same case
            // validates and advances (self-transition is legal).
            return {
              to: null,
              note: `nav resolved employer URL via ${nav.method} (${nav.resolved_ats ?? "unsupported ats"})`,
            };
          }
          return routeNavigationWall(db, app.id, nav, runId);
        }
        upsertOpenReviewItem(db, {
          applicationId: app.id,
          kind: "MANUAL",
          title: "Employer application URL unknown",
          payload: {
            hint: `npm run run -- --pipeline --app ${app.id} --url <ATS_APPLICATION_URL>`,
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
          // Reached only when ESSAY_REQUIRED_GATE_ENABLED=true (the
          // inspector suppresses the needs_essay route otherwise). Even
          // with the gate on, only REQUIRED essay fields block — an
          // optional "anything else?" textarea is simply left blank
          // (essays are never auto-filled either way).
          const essayIds = new Set(
            essayFieldsOnly(inspect.inspection.fields).map((e) => e.field_id),
          );
          const requiredEssays = inspect.inspection.fields.filter(
            (f) => essayIds.has(f.id) && f.required,
          );
          if (requiredEssays.length === 0) {
            const note =
              "only optional essay fields — proceeding, leaving them blank";
            transitionApplication(db, {
              applicationId: app.id,
              nextState: "NATIVE_AUTOFILL_RUNNING",
              reason: `pipeline: ${note}`,
              runId,
            });
            return { to: "NATIVE_AUTOFILL_RUNNING", note };
          }
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
      let operatorBrief: OperatorFieldBrief | undefined;
      if (ctx.options.fixtureHtmlPath) {
        const fillReport = await runAtsFixtureFill("greenhouse", {
          execute: true,
          includeHumanEssays: { db, applicationId: app.id },
        });
        verifyPassed = fillReport.verify?.passed === true;
        detail = `fixture fill: ${fillReport.fill?.filled.length ?? 0} filled`;
        if (fillReport.operator_brief) {
          operatorBrief = fillReport.operator_brief;
        }
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
        const filled = await withNavHandoffPage(ctx, async (handoff) => {
          if (detected.ats !== "greenhouse") {
            const liveReport = await runAtsLiveFill({
              binding: ATS_BINDINGS[detected.ats],
              url,
              execute: true,
              headless: ctx.options.headless ?? false,
              ...(handoff ? { existingPage: handoff } : {}),
            });
            if (!liveReport.gate.ok) {
              return {
                gateFailure: `${detected.ats} live fill refused: ${liveReport.gate.failure_code}`,
                verifyPassed: false,
                detail: "",
                operatorBrief: undefined as OperatorFieldBrief | undefined,
              };
            }
            return {
              gateFailure: null,
              verifyPassed: liveReport.verify?.passed === true,
              detail: `${detected.ats} live fill: ${liveReport.fill?.filled.length ?? 0} filled${handoff ? " (cdp session)" : ""}`,
              operatorBrief: liveReport.operator_brief,
            };
          }
          const liveReport = await runGreenhouseLiveFill({
            url,
            execute: true,
            headless: ctx.options.headless ?? false,
            ...(handoff ? { existingPage: handoff } : {}),
          });
          return {
            gateFailure: null,
            verifyPassed: liveReport.verify?.passed === true,
            detail: `live fill: ${liveReport.fill?.filled.length ?? 0} filled${handoff ? " (cdp session)" : ""}`,
            operatorBrief: liveReport.operator_brief,
          };
        });
        if (filled.gateFailure) {
          return { to: null, note: filled.gateFailure, stop: "gate" };
        }
        verifyPassed = filled.verifyPassed;
        detail = filled.detail;
        operatorBrief = filled.operatorBrief;
      }

      transitionApplication(db, {
        applicationId: app.id,
        nextState: "FIELD_VERIFICATION",
        reason: `pipeline: fill executed (${detail})`,
        runId,
      });
      if (!verifyPassed) {
        // Live fill already printed; fixture path may not have.
        if (operatorBrief && ctx.options.fixtureHtmlPath) {
          printOperatorFieldBrief(operatorBrief);
        }
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
          payload: {
            detail,
            ...(operatorBrief ? { operator_brief: operatorBrief } : {}),
          },
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
        ...(ctx.options.confirmSubmission
          ? { confirmSubmission: ctx.options.confirmSubmission }
          : {}),
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
      const readiness =
        ctx.options.jobrightContactsReady !== undefined
          ? {
              ready: ctx.options.jobrightContactsReady,
              detail: ctx.options.jobrightContactsReady
                ? "test seam: ready"
                : "test seam: not ready",
            }
          : describeSessionReadiness("jobright", "STORAGE_STATE");
      logger.info("contacts step session readiness", {
        service: "pipeline",
        action: "contacts_readiness",
        application_id: app.id,
        metadata: {
          ready: readiness.ready,
          detail: readiness.detail,
          has_fixture: Boolean(ctx.options.contactsFixtureHtmlPath),
        },
      });
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
      try {
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
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("contacts extraction failed", {
          service: "pipeline",
          action: "contacts_error",
          application_id: app.id,
          metadata: {
            error: message.slice(0, 500),
            jobright_ready: readiness.ready,
            fixture: Boolean(ctx.options.contactsFixtureHtmlPath),
          },
        });
        upsertOpenReviewItem(db, {
          applicationId: app.id,
          kind: "MANUAL",
          title: "Contact extraction failed after submit",
          payload: { error: message.slice(0, 500) },
        });
        return {
          to: null,
          note: `contacts extraction failed: ${message.slice(0, 200)}`,
          stop: "review",
        };
      }
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
