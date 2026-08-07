import fs from "node:fs";
import path from "node:path";
import type { Db } from "../storage/db/client.js";
import { getConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { waitForEnter } from "../util/stdin.js";
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
import {
  greenhouseSubmit,
  greenhouseVerifySubmission,
  SubmissionUncertainError,
} from "../ats/greenhouse/submission.js";
import {
  failedApprovedEntries,
  verifyPageBeforeMutation,
} from "../ats/greenhouse/liveFill.js";
import { healFailedFillEntries } from "../ats/greenhouse/fillHealer.js";
import { validateGreenhouseApplicationUrl } from "../ats/greenhouse/urlValidation.js";
import { withPublicUrlPage } from "../browser/fixtureSession.js";
import { getRegisteredResume } from "../jobright/materialsRegister.js";
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
 * Human-approved Greenhouse submission (Phase 7).
 *
 * Layered defenses, in firing order:
 *   env gate (assertSubmitAllowed) → state check → lease →
 *   assertSubmissionAllowed → idempotency claim → page identity gate →
 *   fill verify must pass → per-submission human confirmation (or persisted
 *   unattended cap) → single click → deterministic receipt verification.
 * An unverifiable outcome is UNCERTAIN: review item + idempotency 'uncertain',
 * and nothing ever re-clicks.
 */
export async function runGreenhouseSubmission(input: {
  db: Db;
  applicationId: string;
  headless?: boolean;
  /** Honored only when SUBMIT_REQUIRES_LOCAL_CONFIRMATION=false. */
  assumeYes?: boolean;
  /** Shared per-batch run for the unattended cap; created ad hoc if absent. */
  automationRunId?: string;
}): Promise<SubmissionRunReport> {
  const { db, applicationId } = input;
  const cfg = getConfig();

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
  assertSubmitAllowed("submitRun.runGreenhouseSubmission");

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
  const urlValidation = validateGreenhouseApplicationUrl(employerUrl);
  if (!urlValidation.passed) {
    report.reason = `Employer URL failed Greenhouse validation: ${urlValidation.failureReason}`;
    return report;
  }

  const resume = getRegisteredResume(db, applicationId);
  if (!resume) {
    report.reason =
      "No verified resume material — run materials:register (or resume:download) first";
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
      urlValidation.normalizedUrl ?? employerUrl,
      async (page) => {
        const gate = await verifyPageBeforeMutation(
          page,
          employerUrl,
          urlValidation.normalizedUrl,
        );
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

        // Human confirmation BEFORE any mutation of the page.
        if (cfg.submitRequiresLocalConfirmation) {
          console.log("\n=== SUBMIT CONFIRMATION ===");
          console.log(`  company : ${job?.company ?? "?"}`);
          console.log(`  role    : ${job?.role ?? "?"}`);
          console.log(`  url     : ${gate.finalUrl}`);
          console.log(`  attempt : ${pending.submission_attempt_number}`);
          console.log(`  resume  : sha256 ${resume.sha256.slice(0, 16)}… (${resume.size_bytes} bytes)`);
          console.log(
            `  plan    : ${approvedPlan.fillable_count} fill, ${approvedPlan.skipped_count} skip, ${approvedPlan.review_required_count} review`,
          );
          await waitForEnter(
            "Press Enter to fill and SUBMIT this application, Ctrl+C to abort... ",
          );
        } else {
          if (!tryConsumeUnattendedSubmission(db, runId)) {
            markSubmissionFailed(db, pending.id, "unattended cap reached");
            failIdempotencyKey(db, idemKey, "unattended_cap");
            report.outcome = "REFUSED";
            report.reason = `MAX_UNATTENDED_SUBMISSIONS_PER_RUN cap reached (${cfg.maxUnattendedSubmissionsPerRun}) — refusing unattended submission`;
            return persist(report);
          }
          if (!input.assumeYes) {
            markSubmissionFailed(db, pending.id, "unattended without --yes");
            failIdempotencyKey(db, idemKey, "no_confirmation");
            report.outcome = "REFUSED";
            report.reason =
              "Unattended mode requires an explicit --yes acknowledgment";
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
          const essayEntries = buildHumanEssayEntries(db, applicationId, fields);
          if (essayEntries.length > 0) {
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
          // Phase 6a′: one heal pass before giving up on the click.
          if (!verify.passed) {
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

          const attempt = await greenhouseSubmit(page);
          if (!attempt.clicked) {
            markSubmissionFailed(db, pending.id, attempt.notes.join("; "));
            failIdempotencyKey(db, idemKey, "not_clicked");
            transitionApplication(db, {
              applicationId,
              nextState: "FAILED_RETRYABLE",
              reason: `submit control not clicked: ${attempt.notes.join("; ")}`,
              runId,
            });
            report.outcome = "FAILED_BEFORE_CLICK";
            report.reason = attempt.notes.join("; ");
            return persist(report);
          }

          // Click happened — from here every path is VERIFIED or UNCERTAIN.
          try {
            const receipt = await greenhouseVerifySubmission(page, {
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
      service: "greenhouse",
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
