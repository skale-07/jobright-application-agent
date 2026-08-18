import path from "node:path";
import type { Page } from "playwright";
import { assertReadOnlyInspectionAllowed } from "../../applications/readOnlyInspectionGuards.js";
import { inspectApplicationHtml } from "../../applications/applicationInspector.js";
import {
  withFixtureHtmlPage,
  withPublicUrlPage,
} from "../../browser/fixtureSession.js";
import { getConfig } from "../../config/index.js";
import { redactObject } from "../../logging/redaction.js";
import { writeJsonAtomic } from "../../storage/atomicJson.js";
import { greenhouseSelectorsV1 } from "./selectors.js";
import {
  detectClosedJobSignals,
  detectErrorPageSignals,
  extractBoardTokenFromUrl,
  extractGreenhouseJobIdFromUrl,
  verifyGreenhousePageIdentity,
  type GreenhouseFailureCode,
  type GreenhouseIdentityVerification,
} from "./identityVerification.js";
import {
  verifyFinalNavigation,
  type FinalNavigationVerification,
} from "./finalNavigation.js";
import { detectLoginWall, type LoginWallDetection } from "./loginWallDetection.js";
import {
  detectBlockingCaptcha,
  type CaptchaDetection,
} from "./captchaDetection.js";
import {
  validateGreenhouseApplicationUrl,
  type GreenhouseUrlValidation,
} from "./urlValidation.js";
import {
  buildProposedFillPlan,
  type ProposedFillPlan,
} from "./proposedFillPlan.js";

export type GreenhouseInspectionValidationLevel =
  | "LIVE_READ_ONLY_CONFIRMED"
  | "FIXTURE_CONFIRMED"
  | "UNVERIFIED";

export type GreenhouseLiveInspectReport = {
  validation_level: GreenhouseInspectionValidationLevel;
  requested_url: string;
  normalized_url: string | null;
  final_url: string | null;
  requested_host: string | null;
  final_host: string | null;
  redirect_observed: boolean;
  remained_on_trusted_greenhouse_host: boolean;
  url_validation: GreenhouseUrlValidation;
  final_navigation: FinalNavigationVerification | null;
  identity_verification: GreenhouseIdentityVerification | null;
  login_wall_detection: LoginWallDetection | null;
  captcha_detected: boolean;
  captcha_detection: CaptchaDetection | null;
  form_detected: boolean;
  field_count: number;
  failure_code: GreenhouseFailureCode | string | null;
  failure_reason: string | null;
  ats: string | null;
  company: string | null;
  role: string | null;
  greenhouse_job_id: string | null;
  field_summary: ProposedFillPlan["summary"] | null;
  fields: ProposedFillPlan["entries"];
  proposed_fill_plan: ProposedFillPlan | null;
  warnings: string[];
  inspection_started_at: string;
  inspection_completed_at: string;
  mutation_attempted: false;
  upload_attempted: false;
  submit_attempted: false;
  artifact_path: string | null;
  error: string | null;
  diagnostics?: Record<string, unknown>;
};

export class GreenhouseLiveInspectError extends Error {
  readonly exitCode: number;
  readonly report: GreenhouseLiveInspectReport;

  constructor(
    message: string,
    exitCode: number,
    report: GreenhouseLiveInspectReport,
  ) {
    super(message);
    this.name = "GreenhouseLiveInspectError";
    this.exitCode = exitCode;
    this.report = report;
  }
}

function artifactPathFor(jobId: string | null, board: string | null): string {
  const key = jobId ?? board ?? "unknown";
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(
    getConfig().artifactsDir,
    "inspection",
    `greenhouse-inspect-${key}-${ts}.json`,
  );
}

function writeArtifact(report: GreenhouseLiveInspectReport): string {
  const out = artifactPathFor(
    report.greenhouse_job_id,
    report.url_validation.boardToken,
  );
  report.artifact_path = out;
  const sanitized = redactObject(
    report as unknown as Record<string, unknown>,
  );
  writeJsonAtomic(out, sanitized);
  return out;
}

function baseReport(
  requestedUrl: string,
  urlValidation: GreenhouseUrlValidation,
  started: string,
): GreenhouseLiveInspectReport {
  let requestedHost: string | null = null;
  try {
    requestedHost = new URL(requestedUrl).hostname.toLowerCase();
  } catch {
    requestedHost = null;
  }
  return {
    validation_level: "UNVERIFIED",
    requested_url: requestedUrl,
    normalized_url: urlValidation.normalizedUrl,
    final_url: null,
    requested_host: requestedHost,
    final_host: null,
    redirect_observed: false,
    remained_on_trusted_greenhouse_host: false,
    url_validation: urlValidation,
    final_navigation: null,
    identity_verification: null,
    login_wall_detection: null,
    captcha_detected: false,
    captcha_detection: null,
    form_detected: false,
    field_count: 0,
    failure_code: null,
    failure_reason: null,
    ats: null,
    company: null,
    role: null,
    greenhouse_job_id: urlValidation.greenhouseJobId,
    field_summary: null,
    fields: [],
    proposed_fill_plan: null,
    warnings: [...urlValidation.warnings],
    inspection_started_at: started,
    inspection_completed_at: started,
    mutation_attempted: false,
    upload_attempted: false,
    submit_attempted: false,
    artifact_path: null,
    error: null,
  };
}

function applyNavigationFailure(
  report: GreenhouseLiveInspectReport,
  nav: FinalNavigationVerification,
): void {
  report.final_url = nav.finalUrl;
  report.requested_host = nav.requestedHost;
  report.final_host = nav.finalHost;
  report.redirect_observed = nav.redirectObserved;
  report.remained_on_trusted_greenhouse_host =
    nav.remainedOnTrustedGreenhouseHost;
  report.final_navigation = nav;
  report.form_detected = false;
  report.field_count = 0;
  report.login_wall_detection = { detected: false, confidence: "LOW", signals: [] };
  report.captcha_detected = false;
  report.captcha_detection = null;
  report.failure_code = nav.failureCode;
  report.failure_reason = nav.failureReason;
  report.error = nav.failureReason;
  report.validation_level = "UNVERIFIED";
  report.identity_verification = {
    passed: false,
    requestedUrl: nav.requestedUrl,
    finalUrl: nav.finalUrl,
    requestedJobId: report.url_validation.greenhouseJobId,
    observedJobId: extractGreenhouseJobIdFromUrl(nav.finalUrl),
    company: null,
    role: null,
    formDetected: false,
    fieldCount: 0,
    failureCode: nav.failureCode,
    warnings: [],
    failureReason: nav.failureReason,
  };
}

async function collectPageSignals(page: Page): Promise<{
  finalUrl: string;
  title: string;
  html: string;
  formDetected: boolean;
}> {
  const finalUrl = page.url();
  const title = (await page.title().catch(() => "")) || "";
  const html = await page.content();
  const formDetected =
    (await page.locator(greenhouseSelectorsV1.form).count().catch(() => 0)) >
      0 || /id=["']application_form["']|new_job_application/i.test(html);
  return { finalUrl, title, html, formDetected };
}

async function runInspectionFromHtml(input: {
  requestedUrl: string;
  html: string;
  title: string;
  finalUrl: string;
  formDetected: boolean;
  fixtureMode: boolean;
  saveDiagnostics: boolean;
  report: GreenhouseLiveInspectReport;
}): Promise<void> {
  const {
    requestedUrl,
    html,
    title,
    finalUrl,
    formDetected,
    fixtureMode,
    saveDiagnostics,
    report,
  } = input;

  // Record the landing. Host is not a gate — page-state checks decide.
  const nav = verifyFinalNavigation({
    requestedUrl: report.normalized_url ?? requestedUrl,
    finalUrl,
  });
  report.final_navigation = nav;
  report.final_url = nav.finalUrl;
  report.requested_host = nav.requestedHost;
  report.final_host = nav.finalHost;
  report.redirect_observed = nav.redirectObserved;
  report.remained_on_trusted_greenhouse_host =
    nav.remainedOnTrustedGreenhouseHost;

  if (!nav.passed) {
    applyNavigationFailure(report, nav);
    return;
  }

  // Page-state checks (captcha / login / closed / form). Host is not a gate.
  const loginWall = detectLoginWall({ finalUrl, html, title });
  const closedJobDetected = detectClosedJobSignals(html, title);
  const errorPageDetected = detectErrorPageSignals(html, title);
  const observedJobId = extractGreenhouseJobIdFromUrl(finalUrl);
  const boardToken =
    extractBoardTokenFromUrl(finalUrl) ?? report.url_validation.boardToken;

  report.login_wall_detection = loginWall;
  report.form_detected = formDetected;

  // Fail closed for captcha / high-confidence login / closed before full discovery
  // when form is clearly absent OR signals are strong; still run inspect for fields
  // when form is present (needed for field_count).
  const inspectReport = await inspectApplicationHtml({
    url: finalUrl,
    html,
    title,
  });

  const fieldCount = inspectReport.inspection.fields.length;
  const formOk =
    formDetected ||
    fieldCount > 0 ||
    inspectReport.inspection.ats === "greenhouse";

  report.form_detected = formOk;
  report.field_count = fieldCount;
  report.ats = inspectReport.inspection.ats;
  report.company = boardToken;
  report.role = title || null;

  // Captcha is assessed only once the form is known: a readable application form
  // is evidence nothing is blocking. Dormant markers never abort.
  const captcha = detectBlockingCaptcha({
    finalUrl,
    html,
    title,
    formDetected: formOk,
    fieldCount,
  });
  report.captcha_detection = captcha;
  report.captcha_detected = captcha.detected;
  if (!captcha.detected && captcha.signals.length > 0) {
    report.warnings.push(
      `captcha_${captcha.confidence.toLowerCase()}: ${captcha.signals.join(",")}`,
    );
  }

  const identity = verifyGreenhousePageIdentity({
    requestedUrl,
    finalUrl,
    requestedJobId: report.url_validation.greenhouseJobId,
    observedJobId,
    company: boardToken,
    role: title || null,
    formDetected: formOk,
    fieldCount,
    captchaDetected: captcha.detected,
    loginWall,
    closedJobDetected,
    errorPageDetected,
  });

  report.identity_verification = identity;
  report.greenhouse_job_id =
    identity.observedJobId ?? report.url_validation.greenhouseJobId;
  report.warnings.push(...identity.warnings, ...inspectReport.notes);
  report.failure_code = identity.failureCode;
  report.failure_reason = identity.failureReason;

  if (!identity.passed) {
    report.validation_level = "UNVERIFIED";
    report.error = identity.failureReason;
    return;
  }

  if (inspectReport.inspection.ats !== "greenhouse") {
    report.validation_level = "UNVERIFIED";
    report.failure_code = "ATS_MISMATCH";
    report.failure_reason = `ATS detected as "${inspectReport.inspection.ats}", expected greenhouse`;
    report.error = report.failure_reason;
    return;
  }

  const prefilledFieldIds = new Set<string>();
  for (const f of inspectReport.inspection.fields) {
    if (f.name) {
      const re = new RegExp(
        `name=["']${escapeRegExp(f.name)}["'][^>]*value=["'][^"']+["']`,
        "i",
      );
      if (re.test(html)) prefilledFieldIds.add(f.id);
    }
  }

  const proposed = buildProposedFillPlan(inspectReport.mapped_fields, {
    prefilledFieldIds,
  });
  report.proposed_fill_plan = proposed;
  report.fields = proposed.entries;
  report.field_summary = proposed.summary;
  report.field_count = proposed.entries.length;

  if (saveDiagnostics) {
    report.diagnostics = {
      route: inspectReport.route,
      detection_confidence: inspectReport.detection_confidence,
      field_count: inspectReport.inspection.fields.length,
      page_title: title.slice(0, 200),
      login_wall_signals: loginWall.signals,
    };
  }

  report.validation_level = fixtureMode
    ? "FIXTURE_CONFIRMED"
    : "LIVE_READ_ONLY_CONFIRMED";
  report.error = null;
  report.failure_code = null;
  report.failure_reason = null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Live or fixture Greenhouse read-only inspection.
 * Never fills, uploads, or submits.
 */
export async function inspectGreenhouseApplication(options: {
  url: string;
  /** Offline: inspect fixture/saved HTML without network navigation */
  fixtureHtml?: string;
  /**
   * Override logical final URL for fixture redirect tests
   * (setContent leaves about:blank).
   */
  fixtureFinalUrl?: string;
  headless?: boolean;
  saveDiagnostics?: boolean;
}): Promise<GreenhouseLiveInspectReport> {
  assertReadOnlyInspectionAllowed("greenhouse live inspection");

  const started = new Date().toISOString();
  const urlValidation = validateGreenhouseApplicationUrl(options.url);
  let report = baseReport(
    urlValidation.normalizedUrl ?? options.url.split("?")[0]!,
    urlValidation,
    started,
  );

  if (!urlValidation.passed || !urlValidation.normalizedUrl) {
    report.failure_code = "UNSAFE_URL";
    report.failure_reason =
      urlValidation.failureReason ?? "Unsafe or unsupported ATS URL.";
    report.error = report.failure_reason;
    report.inspection_completed_at = new Date().toISOString();
    writeArtifact(report);
    throw new GreenhouseLiveInspectError(report.error, 1, report);
  }

  const navigateUrl = urlValidation.normalizedUrl;
  const fixtureMode = Boolean(options.fixtureHtml);

  try {
    if (fixtureMode) {
      await withFixtureHtmlPage(options.fixtureHtml!, async (page) => {
        const title =
          (await page.title().catch(() => "")) ||
          (options.url.match(/jobs\/(\d+)/)?.[0] ?? "Greenhouse fixture");
        const html = await page.content();
        const formDetected =
          (await page
            .locator(greenhouseSelectorsV1.form)
            .count()
            .catch(() => 0)) > 0 ||
          /id=["']application_form["']|new_job_application/i.test(html);

        await runInspectionFromHtml({
          requestedUrl: options.url,
          html,
          title,
          finalUrl: options.fixtureFinalUrl ?? navigateUrl,
          formDetected,
          fixtureMode: true,
          saveDiagnostics: Boolean(options.saveDiagnostics),
          report,
        });
      });
    } else {
      await withPublicUrlPage(
        navigateUrl,
        async (page) => {
          await page.waitForTimeout(800);
          const signals = await collectPageSignals(page);
          await runInspectionFromHtml({
            requestedUrl: options.url,
            html: signals.html,
            title: signals.title,
            finalUrl: signals.finalUrl,
            formDetected: signals.formDetected,
            fixtureMode: false,
            saveDiagnostics: Boolean(options.saveDiagnostics),
            report,
          });
        },
        { headless: options.headless ?? false },
      );
    }

    report.inspection_completed_at = new Date().toISOString();
    writeArtifact(report);

    if (report.error || report.validation_level === "UNVERIFIED") {
      throw new GreenhouseLiveInspectError(
        report.error ?? "Greenhouse inspection incomplete",
        1,
        report,
      );
    }

    return report;
  } catch (err) {
    if (err instanceof GreenhouseLiveInspectError) throw err;
    report.error = err instanceof Error ? err.message : String(err);
    report.validation_level = "UNVERIFIED";
    report.failure_code = report.failure_code ?? "NAVIGATION_FAILURE";
    report.failure_reason = report.error;
    report.inspection_completed_at = new Date().toISOString();
    writeArtifact(report);
    throw new GreenhouseLiveInspectError(report.error, 1, report);
  }
}

export function formatGreenhouseInspectConsole(
  report: GreenhouseLiveInspectReport,
): string {
  if (report.validation_level === "UNVERIFIED") {
    const lines = [
      `Greenhouse inspection: UNVERIFIED`,
      report.failure_reason ??
        report.error ??
        "Inspection failed.",
      `Requested host: ${report.requested_host ?? "(none)"}`,
      `Final host: ${report.final_host ?? "(none)"}`,
      `Redirected outside trusted Greenhouse application hosts: ${!report.remained_on_trusted_greenhouse_host}`,
      `Login wall detected: ${report.login_wall_detection?.detected ?? false}`,
      `Mutation attempted: ${report.mutation_attempted}`,
      `Upload attempted: ${report.upload_attempted}`,
      `Submit attempted: ${report.submit_attempted}`,
      `Artifact: ${report.artifact_path ?? "(none)"}`,
    ];
    return lines.join("\n");
  }

  const s = report.field_summary;
  return [
    `Greenhouse inspection: ${report.validation_level}`,
    `ATS detected: ${report.ats ?? "(none)"}`,
    `Final URL: ${report.final_url ?? "(none)"}`,
    `Company: ${report.company ?? "(none)"}`,
    `Role: ${report.role ?? "(none)"}`,
    `Job ID: ${report.greenhouse_job_id ?? "(none)"}`,
    `Identity verified: ${report.identity_verification?.passed ?? false}`,
    `Visible fields: ${report.fields.length}`,
    `Deterministic: ${s?.deterministic ?? 0}`,
    `Sponsorship: ${s?.sponsorship ?? 0}`,
    `Essay: ${s?.essay ?? 0}`,
    `Demographic: ${s?.demographic ?? 0}`,
    `File upload: ${s?.file_upload ?? 0}`,
    `Consent: ${s?.consent ?? 0}`,
    `Unsupported: ${s?.unsupported ?? 0}`,
    `Unknown: ${s?.unknown ?? 0}`,
    `Mutation attempted: ${report.mutation_attempted}`,
    `Upload attempted: ${report.upload_attempted}`,
    `Submit attempted: ${report.submit_attempted}`,
    `Artifact: ${report.artifact_path ?? "(none)"}`,
  ].join("\n");
}
