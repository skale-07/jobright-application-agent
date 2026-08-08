import fs from "node:fs";
import path from "node:path";
import type { Db } from "../storage/db/client.js";
import { getConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import {
  defaultTtyConfirm,
  type ConfirmSubmission,
} from "./submitConfirmation.js";
import { diagnoseDisabledSubmit } from "../ats/shared/submitDiagnostics.js";
import { recoverEmailVerification } from "../verification/recoverSubmitVerification.js";
import {
  resolveVerificationCodeProvider,
  type FetchVerificationCode,
} from "../verification/codeProviders.js";
import { getApplication, transitionApplication } from "../queue/stateMachine.js";
import { acquireLease, releaseLease } from "../queue/leases.js";
import {
  buildIdempotencyKey,
  claimIdempotencyKey,
  completeIdempotencyKey,
  failIdempotencyKey,
  markIdempotencyUncertain,
} from "../queue/idempotency.js";
import { upsertOpenReviewItem } from "../queue/reviewItems.js";
import {
  insertPendingSubmission,
  markSubmissionFailed,
  markSubmissionUncertain,
  markSubmissionVerified,
} from "../queue/submissionsRepo.js";
import {
  createAutomationRun,
  tryConsumeUnattendedSubmission,
} from "../queue/automationRuns.js";
import {
  assertSubmissionAllowed,
} from "./submissionGuards.js";
import { assertSubmitAllowed } from "./formFillGuards.js";
import { planApplicationFill } from "./applicationFiller.js";
import { buildHumanEssayEntries } from "./essayFill.js";
import { greenhouseFillEssays } from "../ats/greenhouse/essayFill.js";
import type { FieldMeta } from "../ats/greenhouse/fill.js";
import { SubmissionUncertainError } from "../ats/shared/submissionUncertain.js";
import { failedApprovedEntries } from "../ats/greenhouse/liveFill.js";
import { healFailedFillEntries } from "../ats/greenhouse/fillHealer.js";
import { detectAtsFromUrl } from "../ats/shared/urlValidationDispatch.js";
import { ATS_BINDINGS } from "./atsBindings.js";
import { withPublicUrlPage } from "../browser/fixtureSession.js";
import { getRegisteredResume } from "../jobright/materialsRegister.js";
import { verifyResumePdfFile } from "../jobright/resumeDownload.js";
import {
  ensureApplicationArtifactDirs,
  writeJsonAtomic,
} from "../storage/atomicJson.js";
import { redactObject } from "../logging/redaction.js";
import type { SubmissionReceipt } from "../ats/adapter.js";

export type SubmissionRunOutcome =
  | "SUBMITTED_VERIFIED"
  | "UNCERTAIN"
  | "REFUSED"
  | "FAILED_BEFORE_CLICK";

export type SubmissionRunReport = {
  outcome: SubmissionRunOutcome;
  application_id: string;
  submission_id: string | null;
  attempt: number | null;
  receipt: SubmissionReceipt | null;
  review_item_id: string | null;
  reason: string;
  artifact_path: string | null;
};

/**
 * Human-approved submission (Phase 7), dispatched per ATS via ATS_BINDINGS
 * (greenhouse / lever / ashby).
 *
 * Layered defenses, in firing order:
 *   env gate (assertSubmitAllowed) → state check → lease →
 *   assertSubmissionAllowed → idempotency claim → per-ATS page gate
 *   (greenhouse: full identity verification; lever/ashby: the weaker
 *   trusted-host/login-wall/captcha/form gate — see preMutationGate.ts) →
 *   fill verify must pass → per-submission human confirmation (or persisted
 *   unattended cap) → single click → deterministic receipt verification.
 * Essays present on an ATS without a wired essay path fail closed BEFORE
 * any mutation. An unverifiable outcome is UNCERTAIN: review item +
 * idempotency 'uncertain', and nothing ever re-clicks.
 */
export async function runAtsSubmission(input: {
  db: Db;
  applicationId: string;
  headless?: boolean;
  /** Honored only when SUBMIT_REQUIRES_LOCAL_CONFIRMATION=false. */
  assumeYes?: boolean;
  /** Shared per-batch run for the unattended cap; created ad hoc if absent. */
  automationRunId?: string;
  /**
   * Confirmation transport (submitConfirmation.ts). Defaults to the TTY
   * prompt — byte-identical CLI behavior. An injected callback (console web
   * modal) sits at exactly the same point; false ⇒ REFUSED before the
   * SUBMITTING transition, so the app stays READY_TO_SUBMIT.
   */
  confirmSubmission?: ConfirmSubmission;
  /**
   * Verification-code source for disabled-submit recovery. Defaults to
   * the flag-gated provider resolution (Outlook web / Gmail readonly);
   * injectable for tests.
   */
  fetchVerificationCode?: FetchVerificationCode;
}): Promise<SubmissionRunReport> {
  const { db, applicationId } = input;
  const cfg = getConfig();
  const runStartedAt = new Date().toISOString();

  const report: SubmissionRunReport = {
    outcome: "REFUSED",
    application_id: applicationId,
    submission_id: null,
    attempt: null,
    receipt: null,
    review_item_id: null,
    reason: "",
    artifact_path: null,
  };

  // Env gate before anything else — no browser, no DB writes when flags refuse.
  assertSubmitAllowed("submitRun.runAtsSubmission");

  const app = getApplication(db, applicationId);
  if (!app) {
    report.reason = `Unknown application: ${applicationId}`;
    return report;
  }
  if (app.state !== "READY_TO_SUBMIT") {
    report.reason = `Application state is ${app.state}, not READY_TO_SUBMIT`;
    return report;
  }

  // Safety-critical guard first: a verified or uncertain prior submission
  // must surface before any mundane refusal (URL, resume, …).
  // Re-checked under the lease below against races.
  assertSubmissionAllowed(db, applicationId);

  const job = db
    .prepare(
      `SELECT j.company, j.role, j.normalized_application_url AS url,
              j.raw_json
       FROM jobs j JOIN applications a ON a.job_id = j.id WHERE a.id = ?`,
    )
    .get(applicationId) as
    | { company: string; role: string; url: string | null; raw_json: string }
    | undefined;
  const raw = job ? (JSON.parse(job.raw_json) as Record<string, unknown>) : {};
  const employerUrl =
    (typeof raw["employer_application_url"] === "string"
      ? (raw["employer_application_url"] as string)
      : null) ?? job?.url;
  if (!employerUrl) {
    report.reason = "No employer application URL stored for this job";
    return report;
  }
  const detected = detectAtsFromUrl(employerUrl);
  if (detected.ats === null) {
    report.reason = `Employer URL failed ATS validation: ${detected.failureReason}`;
    return report;
  }
  const binding = ATS_BINDINGS[detected.ats];

  const resume = getRegisteredResume(db, applicationId);
  if (!resume) {
    report.reason =
      "No verified resume material — run materials:register (or resume:download) first";
    return report;
  }
  // The file may have moved or been corrupted since registration.
  const resumeOnDisk = verifyResumePdfFile(resume.path);
  if (!resumeOnDisk.verified) {
    report.reason = `Registered resume failed on-disk verification: ${resume.path} — ${resumeOnDisk.evidence}. Re-run materials:register.`;
    return report;
  }

  // application_events.run_id references automation_runs(id); reuse the
  // caller's batch run (pipeline) or create our own row for this submission.
  const runId =
    input.automationRunId ??
    createAutomationRun(db, { stage: "submit" }).id;
  acquireLease(db, {
    resourceType: "application",
    resourceId: `${applicationId}:submit`,
    holderRunId: runId,
    ttlMs: 300_000,
  });

  try {
    assertSubmissionAllowed(db, applicationId);

    const pending = insertPendingSubmission(db, { applicationId });
    report.submission_id = pending.id;
    report.attempt = pending.submission_attempt_number;

    const idemKey = buildIdempotencyKey("submit", {
      application_id: applicationId,
      attempt: String(pending.submission_attempt_number),
    });
    claimIdempotencyKey(db, idemKey, {
      holderRunId: runId,
      resourceType: "submission",
      resourceId: pending.id,
    });

    const dirs = ensureApplicationArtifactDirs(applicationId);
    const submissionDir = path.join(dirs.root, "submission");
    fs.mkdirSync(submissionDir, { recursive: true });
    const screenshotPath = path.join(
      submissionDir,
      `receipt-attempt-${pending.submission_attempt_number}.png`,
    );

    return await withPublicUrlPage(
      detected.normalizedUrl,
      async (page) => {
        const gate = await binding.gate(page, employerUrl, detected.normalizedUrl);
        if (!gate.ok) {
          markSubmissionFailed(db, pending.id, `page gate: ${gate.failureCode}`);
          failIdempotencyKey(db, idemKey, gate.failureCode ?? "gate");
          transitionApplication(db, {
            applicationId,
            nextState: "FAILED_RETRYABLE",
            reason: `submit page gate failed: ${gate.failureCode}`,
            runId,
          });
          report.outcome = "FAILED_BEFORE_CLICK";
          report.reason = `Page failed identity gate (${gate.failureCode}): ${gate.reason}`;
          return persist(report);
        }

        const { adapter, approvedPlan, fields } = await planApplicationFill({
          url: gate.finalUrl,
          html: gate.html,
        });
        if (adapter.id !== binding.id) {
          markSubmissionFailed(
            db,
            pending.id,
            `ATS mismatch: URL says ${binding.id}, page detected as ${adapter.id}`,
          );
          failIdempotencyKey(db, idemKey, "ats_mismatch");
          report.outcome = "FAILED_BEFORE_CLICK";
          report.reason = `ATS mismatch: URL validated as ${binding.id} but the page detected as ${adapter.id}`;
          return persist(report);
        }

        // Essays on an ATS without a wired essay path: fail closed BEFORE
        // the confirmation prompt and before any page mutation, leaving the
        // application in READY_TO_SUBMIT so it retries once essays land.
        const essayEntries = buildHumanEssayEntries(db, applicationId, fields);
        if (essayEntries.length > 0 && !binding.supportsEssayFill) {
          markSubmissionFailed(
            db,
            pending.id,
            `${binding.id} essay fill not wired (${essayEntries.length} essay answers present)`,
          );
          failIdempotencyKey(db, idemKey, "essays_not_supported");
          const { item } = upsertOpenReviewItem(db, {
            applicationId,
            kind: "MANUAL",
            title: `Essay answers exist but ${binding.id} essay fill is not wired`,
            payload: {
              ats: binding.id,
              essay_count: essayEntries.length,
              essay_fields: essayEntries.map((e) => e.field_id),
            },
          });
          report.outcome = "FAILED_BEFORE_CLICK";
          report.review_item_id = item.id;
          report.reason = `${binding.id} essay fill is not wired — ${essayEntries.length} human essay answers would be dropped`;
          return persist(report);
        }

        // Human confirmation BEFORE any mutation of the page. The transport
        // is injectable (web modal via the console runner); the default TTY
        // prompt never declines, exactly as before.
        if (cfg.submitRequiresLocalConfirmation) {
          const confirm = input.confirmSubmission ?? defaultTtyConfirm();
          const approved = await confirm({
            application_id: applicationId,
            company: job?.company ?? null,
            role: job?.role ?? null,
            url: gate.finalUrl,
            attempt: pending.submission_attempt_number,
            resume_sha256: resume.sha256,
            resume_size_bytes: resume.size_bytes,
            plan: {
              fillable_count: approvedPlan.fillable_count,
              skipped_count: approvedPlan.skipped_count,
              review_required_count: approvedPlan.review_required_count,
            },
          });
          if (!approved) {
            markSubmissionFailed(
              db,
              pending.id,
              "operator declined submission confirmation",
            );
            failIdempotencyKey(db, idemKey, "operator_declined");
            report.outcome = "REFUSED";
            report.reason =
              "Operator declined (or confirmation timed out) — submission refused";
            return persist(report);
          }
        } else {
          // Check the acknowledgment BEFORE consuming a budget slot — a
          // refusal here must never burn an unattended submission the run
          // never actually made. (Previously the slot was consumed first,
          // so a run without --yes silently decremented the cap.)
          if (!input.assumeYes) {
            markSubmissionFailed(db, pending.id, "unattended without --yes");
            failIdempotencyKey(db, idemKey, "no_confirmation");
            report.outcome = "REFUSED";
            report.reason =
              "Unattended mode requires an explicit --yes acknowledgment";
            return persist(report);
          }
          if (!tryConsumeUnattendedSubmission(db, runId)) {
            markSubmissionFailed(db, pending.id, "unattended cap reached");
            failIdempotencyKey(db, idemKey, "unattended_cap");
            report.outcome = "REFUSED";
            report.reason = `MAX_UNATTENDED_SUBMISSIONS_PER_RUN cap reached (${cfg.maxUnattendedSubmissionsPerRun}) — refusing unattended submission`;
            return persist(report);
          }
        }

        transitionApplication(db, {
          applicationId,
          nextState: "SUBMITTING",
          reason: "human-approved submission started",
          runId,
        });

        try {
          // Fill + essays + upload + verify on the gated page.
          const fill = await adapter.fill(page, approvedPlan.answers);
          if (essayEntries.length > 0 && binding.supportsEssayFill) {
            const fieldMeta = new Map<string, FieldMeta>(
              fields.map((f) => {
                const meta: FieldMeta = { type: f.type };
                if (f.name) meta.name = f.name;
                if (f.inputId) meta.inputId = f.inputId;
                return [f.id, meta] as const;
              }),
            );
            await greenhouseFillEssays(page, essayEntries, fieldMeta, db);
          }
          const upload = await adapter.uploadResume(page, resume.path);
          let verify = await adapter.verify(page, approvedPlan.answers);
          // Phase 6a′: one heal pass before giving up on the click
          // (greenhouse-only until the healer is proven on other ATSes).
          if (!verify.passed && binding.supportsHealing) {
            const failed = failedApprovedEntries(approvedPlan, verify);
            if (failed.length > 0) {
              const heal = await healFailedFillEntries({
                page,
                failedEntries: failed,
              });
              if (heal.healed.length > 0) {
                verify = await adapter.verify(page, approvedPlan.answers);
              }
            }
          }
          if (!verify.passed || !upload.verified || fill.errors.length > 0) {
            markSubmissionFailed(
              db,
              pending.id,
              `pre-submit verification failed (verify=${verify.passed}, upload=${upload.verified}, fillErrors=${fill.errors.length})`,
            );
            failIdempotencyKey(db, idemKey, "verify_failed");
            transitionApplication(db, {
              applicationId,
              nextState: "FAILED_RETRYABLE",
              reason: "pre-submit verification failed",
              runId,
            });
            report.outcome = "FAILED_BEFORE_CLICK";
            report.reason =
              "Refusing to click submit: field verification or upload did not pass";
            return persist(report);
          }

          let attempt = await binding.submit(page);
          if (
            !attempt.clicked &&
            attempt.notes.some((n) => /disabled/i.test(n))
          ) {
            // Name the cause instead of the old opaque "submit control
            // disabled": verification walls, invalid required fields,
            // visible errors. One recovery attempt when it is an email
            // verification code and a mailbox provider is enabled.
            const diagnosis = await diagnoseDisabledSubmit(page);
            attempt.notes.push(`diagnosis: ${diagnosis.summary}`);
            const fetchCode =
              input.fetchVerificationCode ?? resolveVerificationCodeProvider();
            if (diagnosis.verification.detected && fetchCode) {
              const recovery = await recoverEmailVerification(page, diagnosis, {
                fetchCode,
                submitSelector: binding.submitSelector,
                requestedAt: runStartedAt,
              });
              attempt.notes.push(...recovery.notes);
              if (recovery.submitEnabled) {
                attempt = await binding.submit(page);
                attempt.notes.unshift("submit retried after email verification");
              }
            } else if (diagnosis.verification.detected) {
              attempt.notes.push(
                "no mailbox provider enabled (OUTLOOK_VERIFICATION_ENABLED / GMAIL_VERIFICATION_ENABLED) — cannot fetch the code",
              );
            }
          }
          if (!attempt.clicked) {
            const reason = attempt.notes.join("; ");
            markSubmissionFailed(db, pending.id, reason);
            failIdempotencyKey(db, idemKey, "not_clicked");
            if (/verification code required/i.test(reason)) {
              upsertOpenReviewItem(db, {
                applicationId,
                kind: "AUTH_REQUIRED",
                title: "Employer form requires an email verification code",
                payload: {
                  ats: binding.id,
                  notes: attempt.notes,
                },
              });
            }
            transitionApplication(db, {
              applicationId,
              nextState: "FAILED_RETRYABLE",
              reason: `submit control not clicked: ${reason}`,
              runId,
            });
            report.outcome = "FAILED_BEFORE_CLICK";
            report.reason = reason;
            return persist(report);
          }

          // Click happened — from here every path is VERIFIED or UNCERTAIN.
          try {
            const receipt = await binding.verifySubmission(page, {
              screenshotPath,
            });
            markSubmissionVerified(db, pending.id, receipt);
            completeIdempotencyKey(db, idemKey, pending.id);
            transitionApplication(db, {
              applicationId,
              nextState: "SUBMITTED",
              reason: "receipt verified",
              runId,
              artifacts: [receipt.screenshot_path],
            });
            report.outcome = "SUBMITTED_VERIFIED";
            report.receipt = receipt;
            report.reason = receipt.confirmation_text;
            return persist(report);
          } catch (err) {
            const evidence =
              err instanceof SubmissionUncertainError
                ? err.evidence
                : { error: err instanceof Error ? err.message : String(err) };
            markSubmissionUncertain(db, pending.id, evidence);
            markIdempotencyUncertain(
              db,
              idemKey,
              "post-click verification inconclusive",
            );
            const { item } = upsertOpenReviewItem(db, {
              applicationId,
              kind: "UNCERTAIN_SUBMISSION",
              title: "Submission clicked but not verified",
              payload: { ...evidence, submission_id: pending.id },
            });
            transitionApplication(db, {
              applicationId,
              nextState: "SUBMISSION_VERIFICATION_FAILED",
              reason: "post-click verification inconclusive",
              runId,
            });
            report.outcome = "UNCERTAIN";
            report.review_item_id = item.id;
            report.reason =
              err instanceof Error ? err.message : "verification inconclusive";
            return persist(report);
          }
        } catch (err) {
          // Failure before the click (fill/upload/verify machinery threw).
          markSubmissionFailed(
            db,
            pending.id,
            err instanceof Error ? err.message : String(err),
          );
          failIdempotencyKey(db, idemKey, "exception_before_click");
          transitionApplication(db, {
            applicationId,
            nextState: "FAILED_RETRYABLE",
            reason: `submit run error before click: ${err instanceof Error ? err.message : String(err)}`,
            runId,
          });
          report.outcome = "FAILED_BEFORE_CLICK";
          report.reason = err instanceof Error ? err.message : String(err);
          return persist(report);
        }
      },
      { headless: input.headless ?? false },
    );
  } finally {
    releaseLease(db, {
      resourceType: "application",
      resourceId: `${applicationId}:submit`,
      holderRunId: runId,
    });
  }

  function persist(r: SubmissionRunReport): SubmissionRunReport {
    const dirs = ensureApplicationArtifactDirs(r.application_id);
    const out = path.join(
      dirs.root,
      "submission",
      `submit-run-${r.attempt ?? 0}-${Date.now()}.json`,
    );
    fs.mkdirSync(path.dirname(out), { recursive: true });
    writeJsonAtomic(out, redactObject(r as unknown as Record<string, unknown>));
    r.artifact_path = out;
    logger.info("submission run finished", {
      service: detected.ats ?? "unknown",
      action: "submit_run",
      metadata: {
        application_id: r.application_id,
        outcome: r.outcome,
        attempt: r.attempt,
      },
    });
    return r;
  }
}

/** @deprecated Renamed — the run dispatches per ATS now. Kept for existing callers/tests. */
export const runGreenhouseSubmission = runAtsSubmission;
