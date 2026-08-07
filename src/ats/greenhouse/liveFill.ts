import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import {
  planApplicationFill,
  type ApplicationFillReport,
} from "../../applications/applicationFiller.js";
import { assertFormFillAllowed } from "../../applications/formFillGuards.js";
import { redactFillReportForArtifact } from "../../applications/fillReportRedaction.js";
import { withPublicUrlPage } from "../../browser/fixtureSession.js";
import type { PublicProfile } from "../../candidate/publicProfile.js";
import { getConfig } from "../../config/index.js";
import { logger } from "../../logging/logger.js";
import { writeJsonAtomic } from "../../storage/atomicJson.js";
import { recordFillRun } from "../../storage/fillOutcomes.js";
import { GreenhouseAdapterV1 } from "./v1.js";
import { greenhouseSelectorsV1 } from "./selectors.js";
import { detectBlockingCaptcha, type CaptchaDetection } from "./captchaDetection.js";
import { detectLoginWall, type LoginWallDetection } from "./loginWallDetection.js";
import { healFailedFillEntries, type HealReport } from "./fillHealer.js";
import { verifyResumePdfFile } from "../../jobright/resumeDownload.js";
import type { ApprovedFillPlanEntry } from "../../applications/approvedFillPlan.js";
import { verifyFinalNavigation } from "./finalNavigation.js";
import {
  detectClosedJobSignals,
  detectErrorPageSignals,
  extractBoardTokenFromUrl,
  extractGreenhouseJobIdFromUrl,
  verifyGreenhousePageIdentity,
  type GreenhouseIdentityVerification,
} from "./identityVerification.js";
import { validateGreenhouseApplicationUrl } from "./urlValidation.js";

export type GreenhouseLiveFillReport = ApplicationFillReport & {
  validation_level: "LIVE_MUTATION_CONFIRMED" | "LIVE_READ_ONLY_CONFIRMED" | "UNVERIFIED";
  final_url: string | null;
  identity_verification: GreenhouseIdentityVerification | null;
  captcha_detection: CaptchaDetection | null;
  login_wall_detection: LoginWallDetection | null;
  failure_code: string | null;
  mutation_attempted: boolean;
  /** Phase 6a′ heal pass, present when read-back verification failed. */
  heal?: HealReport;
};

/** Approved FILL entries whose read-back verification failed. */
export function failedApprovedEntries(
  approvedPlan: { entries: ApprovedFillPlanEntry[] },
  verify: { fields: Array<{ canonical_field: string; match: boolean }> },
): ApprovedFillPlanEntry[] {
  const failed = new Set(
    verify.fields.filter((f) => !f.match).map((f) => f.canonical_field),
  );
  return approvedPlan.entries.filter(
    (e) =>
      e.approved &&
      e.action === "FILL" &&
      failed.has(e.canonical_field ?? e.field_id),
  );
}

export class GreenhouseLiveFillError extends Error {
  readonly report: GreenhouseLiveFillReport;
  constructor(message: string, report: GreenhouseLiveFillReport) {
    super(message);
    this.name = "GreenhouseLiveFillError";
    this.report = report;
  }
}

/**
 * Re-run the full read-only safety gate on the page we are about to mutate.
 * inspectGreenhouseApplication proves a URL on its own page load; this proves
 * the page actually in hand, so nothing is typed into an unverified document.
 * Exported for the Phase 7 submission path, which must pass the same gate.
 */
export async function verifyPageBeforeMutation(
  page: Page,
  requestedUrl: string,
  normalizedUrl: string | null,
): Promise<{
  ok: boolean;
  finalUrl: string;
  html: string;
  title: string;
  identity: GreenhouseIdentityVerification | null;
  captcha: CaptchaDetection | null;
  loginWall: LoginWallDetection | null;
  failureCode: string | null;
  reason: string | null;
}> {
  const finalUrl = page.url();
  const title = (await page.title().catch(() => "")) || "";
  const html = await page.content();

  const nav = verifyFinalNavigation({
    requestedUrl: normalizedUrl ?? requestedUrl,
    finalUrl,
  });
  if (!nav.passed) {
    return {
      ok: false,
      finalUrl,
      html,
      title,
      identity: null,
      captcha: null,
      loginWall: null,
      failureCode: nav.failureCode,
      reason: nav.failureReason,
    };
  }

  const adapter = new GreenhouseAdapterV1();
  const fields = await adapter.discoverFields({ html });
  const formDetected = greenhouseSelectorsV1.formMarkers.test(html);
  const captcha = detectBlockingCaptcha({
    finalUrl,
    html,
    title,
    formDetected,
    fieldCount: fields.length,
  });
  const loginWall = detectLoginWall({ finalUrl, html, title });

  const identity = verifyGreenhousePageIdentity({
    requestedUrl,
    finalUrl,
    requestedJobId: extractGreenhouseJobIdFromUrl(normalizedUrl ?? requestedUrl),
    observedJobId: extractGreenhouseJobIdFromUrl(finalUrl),
    company: extractBoardTokenFromUrl(finalUrl),
    role: title || null,
    formDetected: formDetected || fields.length > 0,
    fieldCount: fields.length,
    captchaDetected: captcha.detected,
    loginWall,
    closedJobDetected: detectClosedJobSignals(html, title),
    errorPageDetected: detectErrorPageSignals(html, title),
  });

  return {
    ok: identity.passed,
    finalUrl,
    html,
    title,
    identity,
    captcha,
    loginWall,
    failureCode: identity.failureCode,
    reason: identity.failureReason,
  };
}

function tryRecordFillOutcomes(
  report: GreenhouseLiveFillReport,
  reportRelpath: string,
): void {
  if (report.mode !== "executed" || !report.mutation_attempted) return;

  const planEntries = (report.approved_plan?.entries ?? report.plan.entries).map(
    (e) => {
      const base = {
        field_id: e.field_id,
        label: e.label,
        type: e.type as string,
        canonical_field: e.canonical_field ?? null,
        action: String(e.action),
        value: e.value,
        reason: e.reason,
      };
      if ("approved" in e && typeof (e as { approved?: boolean }).approved === "boolean") {
        return {
          ...base,
          approved: (e as { approved: boolean }).approved,
        };
      }
      return base;
    },
  );

  recordFillRun({
    mode: "executed",
    source: "cli_url",
    ats: report.ats,
    job_url: report.final_url ?? report.url,
    company: report.identity_verification?.company ?? null,
    role: report.identity_verification?.role ?? null,
    job_id_observed: report.identity_verification?.observedJobId ?? null,
    mutation_attempted: report.mutation_attempted,
    validation_level: report.validation_level,
    fillable_count:
      report.approved_plan?.fillable_count ?? report.plan.fillable_count,
    skipped_count:
      report.approved_plan?.skipped_count ?? report.plan.skipped_count,
    report_artifact_relpath: reportRelpath,
    notes: report.notes,
    metadata: {
      captcha_detection: report.captcha_detection,
      login_wall_detection: report.login_wall_detection,
      failure_code: report.failure_code,
    },
    plan_entries: planEntries,
    fill: report.fill ?? null,
    verify: report.verify ?? null,
    uploads: report.uploads ?? null,
    heal: report.heal ?? null,
  });
}

function persist(report: GreenhouseLiveFillReport): GreenhouseLiveFillReport {
  const outDir = path.join(getConfig().artifactsDir, "ats-fill", "greenhouse-live");
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(
    outDir,
    report.mode === "plan_only" ? "live-fill-plan.json" : "live-fill-report.json",
  );

  // SQLite outcomes first (uses raw report values) then redacted artifact.
  tryRecordFillOutcomes(report, path.relative(getConfig().artifactsDir, file));

  const redacted = {
    ...redactFillReportForArtifact(report),
    validation_level: report.validation_level,
    final_url: report.final_url,
    identity_verification: report.identity_verification,
    captcha_detection: report.captcha_detection,
    login_wall_detection: report.login_wall_detection,
    failure_code: report.failure_code,
    mutation_attempted: report.mutation_attempted,
    written_at: new Date().toISOString(),
  };
  writeJsonAtomic(file, redacted);
  return { ...report, report_path: file };
}

/**
 * Guarded live Greenhouse fill. Deterministic allowlist fields only; essays,
 * demographics and invented sponsorship are rejected upstream by the approved
 * plan. Submit is never called — the adapter's submit path throws regardless.
 */
export async function runGreenhouseLiveFill(input: {
  url: string;
  execute: boolean;
  profile?: PublicProfile;
  resumePath?: string;
  coverLetterPath?: string;
  headless?: boolean;
}): Promise<GreenhouseLiveFillReport> {
  const urlValidation = validateGreenhouseApplicationUrl(input.url);
  const base: GreenhouseLiveFillReport = {
    mode: input.execute ? "executed" : "plan_only",
    ats: "greenhouse",
    url: input.url,
    plan: { answers: {}, entries: [], fillable_count: 0, skipped_count: 0, review_required_count: 0 },
    submit_attempted: false,
    notes: [],
    validation_level: "UNVERIFIED",
    final_url: null,
    identity_verification: null,
    captcha_detection: null,
    login_wall_detection: null,
    failure_code: null,
    mutation_attempted: false,
  };

  if (!urlValidation.passed) {
    base.failure_code = "UNSAFE_FINAL_URL";
    base.notes.push(urlValidation.failureReason ?? "URL validation failed");
    throw new GreenhouseLiveFillError(
      `Refusing live fill: ${urlValidation.failureReason ?? "invalid Greenhouse application URL"}`,
      persist(base),
    );
  }

  // Resume preflight — hard error before any browser opens, regardless of
  // gates, so a wrong path is the FIRST thing the operator sees, not a
  // soft `verified:false` after the form is nearly complete.
  if (input.resumePath) {
    const abs = path.resolve(input.resumePath);
    const check = verifyResumePdfFile(abs);
    if (!check.verified) {
      base.failure_code = "RESUME_FILE_INVALID";
      base.notes.push(`resume preflight failed: ${abs} — ${check.evidence}`);
      throw new GreenhouseLiveFillError(
        `Resume file failed preflight: ${abs} — ${check.evidence}`,
        persist(base),
      );
    }
  }

  // Fail before opening a browser if flags are wrong.
  if (input.execute) {
    assertFormFillAllowed("greenhouse.liveFill");
  }

  return withPublicUrlPage(
    urlValidation.normalizedUrl ?? input.url,
    async (page) => {
      const gate = await verifyPageBeforeMutation(
        page,
        input.url,
        urlValidation.normalizedUrl,
      );
      base.final_url = gate.finalUrl;
      base.identity_verification = gate.identity;
      base.captcha_detection = gate.captcha;
      base.login_wall_detection = gate.loginWall;
      base.failure_code = gate.failureCode;

      if (!gate.ok) {
        base.notes.push(gate.reason ?? "page failed verification");
        throw new GreenhouseLiveFillError(
          `Refusing live fill (${gate.failureCode}): ${gate.reason}`,
          persist(base),
        );
      }

      const { adapter, plan, approvedPlan } = await planApplicationFill({
        url: gate.finalUrl,
        html: gate.html,
        ...(input.profile ? { profile: input.profile } : {}),
      });
      base.plan = plan;
      base.approved_plan = approvedPlan;

      if (!input.execute) {
        base.mode = "plan_only";
        base.validation_level = "LIVE_READ_ONLY_CONFIRMED";
        base.notes.push(
          "plan_only — no mutation. Set --execute with FORM_FILL_ENABLED=true and DRY_RUN=false to fill.",
        );
        return persist(base);
      }

      // Re-assert immediately before the first mutation.
      assertFormFillAllowed("greenhouse.liveFill.execute");
      base.mutation_attempted = true;

      // Order: fill fields → verify/heal → upload last → freeze.
      // Combobox work re-renders job-boards and can wipe a pristine-zone
      // attach if we uploaded first; leave file inputs until values stick.
      logger.info("live fill: applying approved field plan", {
        service: "greenhouse",
        action: "fill",
        metadata: {
          fillable_count: approvedPlan.fillable_count,
          answer_keys: Object.keys(approvedPlan.answers),
        },
      });
      base.fill = await adapter.fill(page, approvedPlan.answers);
      logger.info("live fill: field plan applied", {
        service: "greenhouse",
        action: "fill",
        metadata: {
          filled: base.fill.filled.length,
          skipped: base.fill.skipped.length,
          errors: base.fill.errors.length,
        },
      });

      logger.info("live fill: verifying field read-back", {
        service: "greenhouse",
        action: "verify",
      });
      base.verify = await adapter.verify(page, approvedPlan.answers);

      // Phase 6a′: heal read-back failures (heuristic always; sidecar only
      // behind AGENT_FALLBACK_ENABLED), then re-verify deterministically.
      if (!base.verify.passed) {
        const failedBefore = failedApprovedEntries(approvedPlan, base.verify);
        if (failedBefore.length > 0) {
          const heal = await healFailedFillEntries({
            page,
            failedEntries: failedBefore,
          });
          base.heal = heal;
          // Always re-verify and derive the note from FINAL truth: fields
          // that actually flipped fail→pass — never from the heal report's
          // own claims (the 774cc9b-era "8/8 recovered" lie).
          base.verify = await adapter.verify(page, approvedPlan.answers);
          const failedAfter = new Set(
            failedApprovedEntries(approvedPlan, base.verify).map(
              (e) => e.field_id,
            ),
          );
          const recovered = failedBefore.filter(
            (e) => !failedAfter.has(e.field_id),
          ).length;
          base.notes.push(
            `heal pass: recovered ${recovered}/${failedBefore.length}; final verify passed: ${base.verify.passed}` +
              (heal.sidecar_used ? " (sidecar consulted)" : ""),
          );
        }
      }

      // Upload only after comboboxes are settled — no further field mutation.
      const uploads = [];
      if (input.resumePath) {
        logger.info("live fill: uploading resume", {
          service: "greenhouse",
          action: "upload",
        });
        uploads.push(await adapter.uploadResume(page, input.resumePath));
      }
      if (input.coverLetterPath && adapter.uploadCoverLetter) {
        logger.info("live fill: uploading cover letter", {
          service: "greenhouse",
          action: "upload",
        });
        uploads.push(
          await adapter.uploadCoverLetter(page, input.coverLetterPath),
        );
      } else if (input.coverLetterPath) {
        base.notes.push(
          `cover letter skipped — ${adapter.id} has no cover-letter file input`,
        );
      }
      if (uploads.length > 0) {
        base.uploads = uploads;
        const bad = uploads.filter((u) => !u.verified);
        if (bad.length > 0) {
          base.notes.push(
            `upload not verified after fill: ${bad.map((u) => u.field).join(", ")}`,
          );
        }
      }

      base.notes.push(
        "frozen after fill→verify→upload — no further field mutation; submit never called",
      );
      const uploadsOk =
        !base.uploads?.length || base.uploads.every((u) => u.verified);
      base.validation_level =
        base.verify.passed && uploadsOk
          ? "LIVE_MUTATION_CONFIRMED"
          : "UNVERIFIED";
      return persist(base);
    },
    { headless: input.headless ?? false },
  );
}
