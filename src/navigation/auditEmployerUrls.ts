import type { Db } from "../storage/db/client.js";
import { logger } from "../logging/logger.js";
import { clearEmployerApplicationUrl } from "../applications/employerUrl.js";
import { upsertOpenReviewItem } from "../queue/reviewItems.js";
import { transitionApplication } from "../queue/stateMachine.js";
import { canTransition, type ApplicationState } from "../queue/states.js";
import { checkUrlCongruence } from "./congruence.js";

/**
 * Employer-URL audit — the self-healing sweep for URLs stored BEFORE the
 * congruence gate existed. The live failure it repairs: the nav agent
 * returned one company's application URL for three unrelated jobs, and
 * those poisoned rows sat in the queue re-filling the wrong form every
 * session. The armed worker runs this at session start (no operator
 * command needed): a stored URL whose org slug contradicts the job's
 * company is cleared and the application is routed back to
 * APPLICATION_OPENING, where navigation — now congruence-gated — resolves
 * it properly. Duplicate URLs across applications park the newer ones.
 *
 * Repair scope is deliberately pre-submit only. An app that already
 * SUBMITTED against a mismatched URL is evidence of a real incident —
 * that parks for a human, never silently "repairs".
 */

/** States the audit may autonomously reroute back through navigation. */
const AUTO_REPAIRABLE: ReadonlySet<string> = new Set([
  "DISCOVERED",
  "DUPLICATE_CHECK",
  "ELIGIBILITY_CHECK",
  "QUEUED",
  "MATERIALS_GENERATING",
  "RESUME_DOWNLOADED",
  "COVER_LETTER_REQUIRED",
  "COVER_LETTER_DOWNLOADED",
  "APPLICATION_OPENING",
  "ATS_DETECTION",
  "APPLICATION_INSPECTION",
  "JOBRIGHT_AUTOFILL_RUNNING",
  "JOBRIGHT_AUTOFILL_VERIFICATION",
  "FORM_RESETTING",
  "NATIVE_AUTOFILL_RUNNING",
  "FIELD_VERIFICATION",
  "ESSAY_REQUIRED",
  "AMBIGUOUS_FIELD",
  "AUTH_REQUIRED",
  "CAPTCHA_REQUIRED",
  "UNSUPPORTED_ATS",
  "READY_TO_SUBMIT",
  "FAILED_RETRYABLE",
]);

export type NavAuditReport = {
  applications_checked: number;
  mismatches_found: number;
  repaired: number;
  parked: number;
  duplicates_parked: number;
  notes: string[];
};

export function auditEmployerUrls(db: Db): NavAuditReport {
  const report: NavAuditReport = {
    applications_checked: 0,
    mismatches_found: 0,
    repaired: 0,
    parked: 0,
    duplicates_parked: 0,
    notes: [],
  };

  const rows = db
    .prepare(
      `SELECT a.id AS application_id, a.state, a.created_at, j.company, j.role,
              json_extract(j.raw_json, '$.employer_application_url') AS employer_url
       FROM applications a JOIN jobs j ON a.job_id = j.id
       WHERE json_extract(j.raw_json, '$.employer_application_url') IS NOT NULL
       ORDER BY a.created_at ASC`,
    )
    .all() as Array<{
    application_id: string;
    state: string;
    created_at: string;
    company: string;
    role: string;
    employer_url: string;
  }>;

  const urlHolders = new Map<string, string>(); // normalized URL → first (oldest) app id
  for (const row of rows) {
    report.applications_checked += 1;
    const cong = checkUrlCongruence(row.company ?? "", row.employer_url);

    if (cong.verdict === "mismatch") {
      report.mismatches_found += 1;
      const rerouted =
        AUTO_REPAIRABLE.has(row.state) &&
        (() => {
          clearEmployerApplicationUrl(db, row.application_id);
          return rerouteToNavigation(
            db,
            row.application_id,
            row.state as ApplicationState,
            cong.detail,
          );
        })();
      if (rerouted) {
        report.repaired += 1;
        report.notes.push(
          `repaired ${row.application_id.slice(0, 8)} (${row.company} — ${row.role}): cleared wrong-employer URL (${cong.detail}), re-navigating`,
        );
      } else {
        upsertOpenReviewItem(db, {
          applicationId: row.application_id,
          kind: "MANUAL",
          title: `Application URL belongs to "${cong.slug}", not ${row.company} — needs human review`,
          payload: {
            source: "nav_audit",
            state: row.state,
            employer_url: row.employer_url,
            congruence: cong,
            hint: AUTO_REPAIRABLE.has(row.state)
              ? "Wrong-employer URL cleared, but the state machine offers no automatic route back to navigation from here. Requeue or dismiss."
              : "This application progressed past submit with a wrong-employer URL. Verify what was actually submitted before acting.",
          },
        });
        report.parked += 1;
        report.notes.push(
          `parked ${row.application_id.slice(0, 8)} (${row.company}): wrong-employer URL in state ${row.state} — human review`,
        );
      }
      continue;
    }

    // Duplicate detection among congruent URLs: oldest application keeps
    // the posting; newer ones park for a dismissal decision.
    const key = row.employer_url.replace(/[?#].*$/, "").replace(/\/+$/, "");
    const holder = urlHolders.get(key);
    if (holder === undefined) {
      urlHolders.set(key, row.application_id);
    } else if (AUTO_REPAIRABLE.has(row.state)) {
      upsertOpenReviewItem(db, {
        applicationId: row.application_id,
        kind: "MANUAL",
        title: "Duplicate posting — an earlier application already targets this URL",
        payload: {
          source: "nav_audit",
          employer_url: row.employer_url,
          duplicate_of: holder,
          hint: "Same application URL as an earlier application (double listing or stale navigation). Dismiss this one; the original keeps going.",
        },
      });
      report.duplicates_parked += 1;
      report.notes.push(
        `parked duplicate ${row.application_id.slice(0, 8)} (${row.company}): URL already held by ${holder.slice(0, 8)}`,
      );
    }
  }

  logger.info("employer URL audit finished", {
    service: "navigation",
    action: "nav_audit",
    metadata: { ...report, notes: report.notes.slice(0, 20) },
  });
  return report;
}

/**
 * Route a repaired app back to navigation via legal state edges only.
 * Returns false when no legal chain exists — the caller parks it instead.
 * States BEFORE the opening stage need no transition: their pipeline path
 * passes through APPLICATION_OPENING naturally, where a missing URL
 * triggers navigation.
 */
const PRE_OPENING_STATES: ReadonlySet<string> = new Set([
  "DISCOVERED",
  "DUPLICATE_CHECK",
  "ELIGIBILITY_CHECK",
  "QUEUED",
  "MATERIALS_GENERATING",
  "RESUME_DOWNLOADED",
  "COVER_LETTER_REQUIRED",
  "COVER_LETTER_DOWNLOADED",
]);

function rerouteToNavigation(
  db: Db,
  applicationId: string,
  state: ApplicationState,
  why: string,
): boolean {
  if (state === "APPLICATION_OPENING" || PRE_OPENING_STATES.has(state)) {
    return true; // navigation happens on the app's natural path
  }
  const reason = `nav audit: wrong-employer URL cleared (${why})`;
  const chains: ApplicationState[][] = [
    ["APPLICATION_OPENING"],
    ["FAILED_RETRYABLE", "APPLICATION_OPENING"],
    ["FIELD_VERIFICATION", "FAILED_RETRYABLE", "APPLICATION_OPENING"],
  ];
  for (const chain of chains) {
    let from: ApplicationState = state;
    if (!chain.every((next) => (canTransition(from, next) ? ((from = next), true) : false))) {
      continue;
    }
    for (const next of chain) {
      transitionApplication(db, { applicationId, nextState: next, reason });
    }
    return true;
  }
  return false;
}
