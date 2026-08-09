import type { Db } from "../storage/db/client.js";
import { getConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import {
  runPipeline,
  type PipelineAppReport,
  type PipelineOptions,
} from "../pipeline/runPipeline.js";
import { runJobRightDiscovery } from "../jobright/discoveryRun.js";
import { getApplication } from "../queue/stateMachine.js";
import { upsertOpenReviewItem } from "../queue/reviewItems.js";
import { listContacts } from "../contacts/repository.js";
import { rankOutreachContacts } from "../contacts/rank.js";
import { generateEssayDraftBatch } from "../applications/essayDraft.js";
import { generateEmailForContact } from "../contacts/emailGenerate.js";
import { OpenAiEmailClient, type EmailLlmClient } from "../contacts/emailLlm.js";
import {
  createOutlookDraft,
  verifyOutlookDraft,
  type DraftReport,
  type DraftVerificationReport,
} from "../outlook/draftRun.js";
import {
  getActiveArmSession,
  consumeArmApplication,
  noteArmError,
} from "./armSession.js";

/**
 * The L3 autonomous worker: while an armed session is live and under its
 * app cap, discover/process/fill/submit one application at a time, parking
 * walls and continuing the queue. It owns no capability of its own — every
 * gate still runs inside runPipeline/runAtsSubmission, and submits are
 * unattended only because the armed child env relaxed the confirmation
 * (A4) and the arm row carries the budget. The worker adds no unbounded
 * loops: caps live in nav/submit/heal already, and this loop is bounded by
 * the arm's app cap, its expiry, and the queue running dry.
 */

const DEFAULT_DELAY_MS: [number, number] = [15_000, 45_000];

export type AutomationStopReason =
  | "disarmed"
  | "expired"
  | "apps_cap"
  | "queue_drained"
  | "error";

export type AutomationAppResult = {
  application_id: string;
  end_state: string;
  stopped: string | null;
  stop_reason: string | null;
  submitted: boolean;
  /**
   * Referral-tail outcome for this app, or null when the tail never ran.
   * The first live L3 session reported emails_generated: 0 with no way to
   * tell "no verified submit" from "flag off" from "no contacts" — every
   * skip now names itself.
   */
  outreach: {
    email_status: OutreachTailResult["email_status"];
    draft_status: OutreachTailResult["draft_status"];
    skip_reason: string | null;
  } | null;
};

export type AutomationSessionReport = {
  arm_run_id: string;
  apps_started: number;
  submits_used: number;
  stopped_reason: AutomationStopReason;
  discover_runs: number;
  emails_generated: number;
  drafts_saved: number;
  /** Essay suggestion drafts generated into review items (UNVERIFIED). */
  essay_drafts_generated: number;
  notes: string[];
  per_app: AutomationAppResult[];
};

export type AutomationProgress = {
  apps_started: number;
  submits_used: number;
  last_error_code: string | null;
};

type DiscoveryRunner = (maxJobs: number) => Promise<{ jobs_inspected: number }>;
type DraftRunner = (input: {
  db: Db;
  applicationId: string;
  contactId: string;
  headless?: boolean;
}) => Promise<DraftReport>;
type DraftVerifier = (input: {
  db: Db;
  draftId: string;
  headless?: boolean;
}) => Promise<DraftVerificationReport>;

export type AutomationSessionInput = {
  db: Db;
  armRunId: string;
  headless?: boolean;
  /** 0 disables discovery entirely (process only the existing queue). */
  discoverMax?: number;
  rediscoverEvery?: number;
  /** [min,max] ms slept between apps; test seams pass a tiny range. */
  delayMsRange?: [number, number];
  sleep?: (ms: number) => Promise<void>;
  /** Test seams forwarded to each runPipeline call. */
  fixtureHtmlPath?: string;
  navigationRunner?: PipelineOptions["navigationRunner"];
  contactsFixtureHtmlPath?: string;
  /** Test seam replacing live discovery. */
  discoveryRunner?: DiscoveryRunner;
  /** Test seams for the post-submit outreach tail (drafts only, never send). */
  emailClient?: EmailLlmClient;
  /** Test seam for the post-session essay draft batch. */
  essayDraftClient?: EmailLlmClient;
  draftRunner?: DraftRunner;
  draftVerifier?: DraftVerifier;
  /** Progress sink (the runner turns this into SSE frames). */
  onProgress?: (p: AutomationProgress) => void;
  /** Deterministic jitter for tests (default Math.random via index). */
  nextDelayMs?: (range: [number, number], index: number) => number;
};

/**
 * Next QUEUED (else any advanceable) app with no open review, not excluded,
 * and not already processed this session. The seen-set matters because a
 * single runPipeline call takes an app as far as it can go; if it stops at
 * a gate (e.g. submit not allowed → parks at READY_TO_SUBMIT) with no
 * review item, re-picking it would loop forever on the same result.
 */
function pickNextApplication(db: Db, seen: Set<string>): string | null {
  const query = (states: string) =>
    db
      .prepare(
        `SELECT a.id, a.versions_json FROM applications a
         WHERE a.state IN (${states})
           AND NOT EXISTS (
             SELECT 1 FROM review_items r
             WHERE r.application_id = a.id
               AND r.status IN ('OPEN', 'IN_PROGRESS'))
         ORDER BY a.created_at ASC`,
      )
      .all() as Array<{ id: string; versions_json: string }>;

  const firstEligible = (
    rows: Array<{ id: string; versions_json: string }>,
  ): string | null => {
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      let excluded = false;
      try {
        const v = JSON.parse(row.versions_json) as { automation_excluded?: unknown };
        excluded = v.automation_excluded === true;
      } catch {
        excluded = false;
      }
      if (!excluded) return row.id;
    }
    return null;
  };

  // QUEUED first, then anything else the pipeline can still advance.
  const queued = firstEligible(query("'QUEUED'"));
  if (queued) return queued;
  return firstEligible(
    query(
      `'MATERIALS_GENERATING','RESUME_DOWNLOADED','APPLICATION_OPENING',` +
        `'ATS_DETECTION','APPLICATION_INSPECTION','NATIVE_AUTOFILL_RUNNING',` +
        `'FIELD_VERIFICATION','READY_TO_SUBMIT'`,
    ),
  );
}

export type OutreachTailResult = {
  application_id: string;
  email_status: "generated" | "rejected" | "skipped" | null;
  draft_status: "verified" | "saved" | "refused" | "failed" | "skipped" | null;
  notes: string[];
};

/**
 * The M6 tail: after a verified submit the pipeline dead-ends at
 * CONTACTS_EXTRACTED / EMAIL_GENERATED (stop:"gate") — this picks those up
 * when the child env carries the outreach flags. Drafts only, never send:
 * the only mailbox mutation is createOutlookDraft, which is itself behind
 * OUTLOOK_DRAFTS_ENABLED + DRY_RUN and the sendGuards/check-forbidden bans.
 * Every failure lands as a review item + note — the submission is never
 * reversed and the session loop never dies on outreach.
 */
export async function runOutreachTail(input: {
  db: Db;
  applicationId: string;
  headless?: boolean;
  emailClient?: EmailLlmClient;
  draftRunner?: DraftRunner;
  draftVerifier?: DraftVerifier;
}): Promise<OutreachTailResult> {
  const { db, applicationId } = input;
  const result: OutreachTailResult = {
    application_id: applicationId,
    email_status: null,
    draft_status: null,
    notes: [],
  };
  const cfg = getConfig();

  try {
    // Phase 1 — outreach generation (spend surface; generateEmailForContact
    // re-asserts the gate itself). REJECTED already opened a review item.
    if (getApplication(db, applicationId)?.state === "CONTACTS_EXTRACTED") {
      if (!cfg.emailGenerationEnabled || !cfg.openaiApiKey) {
        result.email_status = "skipped";
        result.notes.push("email generation gated off");
        return result;
      }
      const jobRole =
        (
          db
            .prepare(
              `SELECT j.role AS role FROM jobs j
               JOIN applications a ON a.job_id = j.id WHERE a.id = ?`,
            )
            .get(applicationId) as { role: string | null } | undefined
        )?.role ?? null;
      const contact = rankOutreachContacts(
        listContacts(db, applicationId),
        jobRole,
      )[0];
      if (!contact) {
        result.email_status = "skipped";
        result.notes.push("no contact with both name and email");
        return result;
      }
      const gen = await generateEmailForContact({
        db,
        applicationId,
        contactId: contact.id,
        client: input.emailClient ?? new OpenAiEmailClient(),
      });
      if (gen.validation_status !== "VALIDATED") {
        result.email_status = "rejected";
        result.notes.push("generation rejected — review item opened");
        return result;
      }
      result.email_status = "generated";
    }

    // Phase 2 — Outlook draft (mailbox mutation; createOutlookDraft
    // re-asserts drafts-only + DRY_RUN). Verify by deterministic read-back.
    if (getApplication(db, applicationId)?.state === "EMAIL_GENERATED") {
      if (!cfg.outlookDraftsEnabled || cfg.dryRun) {
        result.draft_status = "skipped";
        result.notes.push("draft creation gated off");
        return result;
      }
      const gen = db
        .prepare(
          `SELECT contact_id FROM email_generations
           WHERE application_id = ? AND validation_status = 'VALIDATED'
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(applicationId) as { contact_id: string } | undefined;
      if (!gen) {
        result.draft_status = "skipped";
        result.notes.push("no VALIDATED generation to draft from");
        return result;
      }
      const create = input.draftRunner ?? createOutlookDraft;
      const draft = await create({
        db,
        applicationId,
        contactId: gen.contact_id,
        headless: input.headless ?? true,
      });
      if (draft.status !== "SAVED" || !draft.draft_id) {
        result.draft_status = draft.status === "REFUSED" ? "refused" : "failed";
        result.notes.push(`draft ${draft.status}: ${draft.reason}`);
        if (draft.status === "FAILED") {
          upsertOpenReviewItem(db, {
            applicationId,
            kind: "MANUAL",
            title: "Outreach draft failed after submit",
            payload: { reason: draft.reason },
          });
        }
        return result;
      }
      const verify = input.draftVerifier ?? verifyOutlookDraft;
      const v = await verify({
        db,
        draftId: draft.draft_id,
        headless: input.headless ?? true,
      });
      result.draft_status = v.verified ? "verified" : "saved";
      if (!v.verified) result.notes.push(`draft saved but unverified: ${v.notes.join("; ")}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.notes.push(`outreach tail error: ${message.slice(0, 200)}`);
    upsertOpenReviewItem(db, {
      applicationId,
      kind: "MANUAL",
      title: "Outreach tail failed after submit",
      payload: { error: message.slice(0, 500) },
    });
    logger.warn("outreach tail failed — submission unaffected", {
      service: "automation",
      action: "outreach_tail_error",
      metadata: { application_id: applicationId },
    });
  }
  return result;
}

/** End states the outreach tail can pick up from. */
const TAIL_STATES = new Set(["CONTACTS_EXTRACTED", "EMAIL_GENERATED"]);

export async function runAutomationSession(
  input: AutomationSessionInput,
): Promise<AutomationSessionReport> {
  const { db, armRunId } = input;
  const discoverMax = Math.max(0, input.discoverMax ?? 0);
  const rediscoverEvery = Math.max(1, input.rediscoverEvery ?? 5);
  const delayRange = input.delayMsRange ?? DEFAULT_DELAY_MS;
  const sleep = input.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const discover: DiscoveryRunner =
    input.discoveryRunner ??
    (async (maxJobs) => runJobRightDiscovery({ maxJobs, headless: input.headless ?? true }));

  const report: AutomationSessionReport = {
    arm_run_id: armRunId,
    apps_started: 0,
    submits_used: 0,
    stopped_reason: "queue_drained",
    discover_runs: 0,
    emails_generated: 0,
    drafts_saved: 0,
    essay_drafts_generated: 0,
    notes: [],
    per_app: [],
  };
  let lastErrorCode: string | null = null;
  /** Record the code for progress frames AND the arm row (Overview card). */
  const noteError = (code: string): void => {
    lastErrorCode = code;
    noteArmError(db, armRunId, code);
  };

  const emit = (): void =>
    input.onProgress?.({
      apps_started: report.apps_started,
      submits_used: report.submits_used,
      last_error_code: lastErrorCode,
    });

  /** Feed touch that never kills the loop: discovery throws on empty/auth. */
  const tryDiscover = async (): Promise<void> => {
    if (discoverMax <= 0) {
      logger.info("automation discover skipped (discover_max=0)", {
        service: "automation",
        action: "discover_skip",
        metadata: { arm_run_id: armRunId },
      });
      return;
    }
    logger.info("automation discover starting", {
      service: "automation",
      action: "discover_begin",
      metadata: { arm_run_id: armRunId, discover_max: discoverMax },
    });
    try {
      const r = await discover(discoverMax);
      report.discover_runs += 1;
      report.notes.push(`discover: ${r.jobs_inspected} inspected`);
      logger.info("automation discover finished", {
        service: "automation",
        action: "discover_end",
        metadata: {
          arm_run_id: armRunId,
          jobs_inspected: r.jobs_inspected,
          discover_runs: report.discover_runs,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      noteError(
        /AUTH_REQUIRED/.test(message)
          ? "jobright_auth"
          : /EMPTY_FEED/.test(message)
            ? "empty_feed"
            : "discover_error",
      );
      report.notes.push(`discover skipped (${lastErrorCode})`);
      logger.warn("automation discover failed", {
        service: "automation",
        action: "discover_error",
        metadata: {
          arm_run_id: armRunId,
          code: lastErrorCode,
          error: message.slice(0, 500),
        },
      });
    }
  };

  logger.info("automation session begin", {
    service: "automation",
    action: "session_begin",
    metadata: {
      arm_run_id: armRunId,
      headless: input.headless ?? true,
      discover_max: discoverMax,
      rediscover_every: rediscoverEvery,
      delay_ms_range: delayRange,
    },
  });

  await tryDiscover();
  let appsSinceDiscover = 0;
  // Each app is attempted at most once per session (see pickNextApplication).
  const seen = new Set<string>();
  /** Verified-submit apps whose referral tail runs after the loop (batch). */
  const tailQueue: Array<{ appId: string; appResult: AutomationAppResult }> = [];

  // The active-arm helper both validates status+expiry and lazily sweeps an
  // expired row, so it is the single source of truth for "still armed".
  for (let iter = 0; ; iter++) {
    emit();
    const active = getActiveArmSession(db);
    if (!active || active.row.id !== armRunId) {
      // Distinguish expiry from an operator disarm by the armed_until in the
      // row's metadata — getActiveArmSession may have just swept an expired
      // row to COMPLETED, so status alone cannot tell them apart.
      const row = db
        .prepare(`SELECT metadata_json AS m FROM automation_runs WHERE id = ?`)
        .get(armRunId) as { m: string } | undefined;
      let expired = false;
      if (row) {
        try {
          const until = Date.parse(
            (JSON.parse(row.m) as { armed_until?: string }).armed_until ?? "",
          );
          expired = Number.isFinite(until) && Date.now() >= until;
        } catch {
          expired = false;
        }
      }
      report.stopped_reason = expired ? "expired" : "disarmed";
      logger.info("automation loop exit: arm inactive", {
        service: "automation",
        action: "session_stop",
        metadata: {
          arm_run_id: armRunId,
          stopped_reason: report.stopped_reason,
          apps_started: report.apps_started,
        },
      });
      break;
    }

    if (discoverMax > 0 && appsSinceDiscover >= rediscoverEvery) {
      await tryDiscover();
      appsSinceDiscover = 0;
    }

    const submitsLeft =
      active.row.max_unattended_submissions - active.row.unattended_submissions_count;
    const allowSubmit = submitsLeft > 0;

    let appId = pickNextApplication(db, seen);
    if (!appId && discoverMax > 0) {
      // Queue drained — one more discovery before giving up.
      await tryDiscover();
      appsSinceDiscover = 0;
      appId = pickNextApplication(db, seen);
    }
    if (!appId) {
      report.stopped_reason = "queue_drained";
      logger.info("automation loop exit: queue drained", {
        service: "automation",
        action: "session_stop",
        metadata: {
          arm_run_id: armRunId,
          seen_count: seen.size,
          apps_started: report.apps_started,
        },
      });
      break;
    }

    if (!consumeArmApplication(db, armRunId)) {
      report.stopped_reason = "apps_cap";
      logger.info("automation loop exit: apps cap", {
        service: "automation",
        action: "session_stop",
        metadata: {
          arm_run_id: armRunId,
          apps_started: report.apps_started,
          max_apps: active.meta.max_apps,
        },
      });
      break;
    }
    seen.add(appId);
    report.apps_started += 1;

    const appRow = getApplication(db, appId);
    logger.info("automation processing app", {
      service: "automation",
      action: "app_begin",
      application_id: appId,
      metadata: {
        arm_run_id: armRunId,
        start_state: appRow?.state ?? null,
        allow_submit: allowSubmit,
        submits_left: submitsLeft,
        apps_started: report.apps_started,
        max_apps: active.meta.max_apps,
        headless: input.headless ?? true,
      },
    });

    try {
      const pipelineReport = await runPipeline({
        db,
        applicationId: appId,
        submit: allowSubmit,
        assumeYes: true,
        automationRunId: armRunId,
        headless: input.headless ?? true,
        ...(input.fixtureHtmlPath ? { fixtureHtmlPath: input.fixtureHtmlPath } : {}),
        ...(input.contactsFixtureHtmlPath
          ? { contactsFixtureHtmlPath: input.contactsFixtureHtmlPath }
          : {}),
        ...(input.navigationRunner ? { navigationRunner: input.navigationRunner } : {}),
      });
      const appReport: PipelineAppReport | undefined = pipelineReport.applications[0];
      if (appReport) {
        const appResult = toAppResult(db, appReport);
        report.per_app.push(appResult);
        logger.info("automation app pipeline result", {
          service: "automation",
          action: "app_end",
          application_id: appId,
          metadata: {
            start_state: appReport.start_state,
            end_state: appReport.end_state,
            stopped: appReport.stopped,
            stop_reason: appReport.stop_reason,
            submitted: toAppResult(db, appReport).submitted,
            steps: appReport.steps.map((s) => `${s.from}→${s.to ?? "—"}: ${s.note}`),
          },
        });
        if (appReport.stopped == null) {
          noteError("anomaly_no_stop");
          report.notes.push(`anomaly: ${appId} stopped with no reason`);
        }
        // Post-submit outreach tail (drafts only, never send). Only states a
        // verified submit can reach; failures are review items, not stops.
        if (appResult.submitted && !TAIL_STATES.has(appReport.end_state)) {
          // Verified submit but the pipeline never reached a tail state —
          // contacts extraction didn't run (flag off, extraction failed, or
          // the pipeline stopped earlier). Name it instead of a silent 0.
          appResult.outreach = {
            email_status: null,
            draft_status: null,
            skip_reason: `tail unreachable from end_state ${appReport.end_state} — contacts extraction did not run`,
          };
          report.notes.push(
            `outreach ${appId}: skipped — end_state ${appReport.end_state} (no contacts extracted)`,
          );
        }
        if (TAIL_STATES.has(appReport.end_state)) {
          // Batched: the tail (text API + Outlook browser) runs AFTER the
          // session loop, so an armed window is spent on applications, not
          // on waiting for a drafting model between them.
          tailQueue.push({ appId, appResult });
          report.notes.push(`outreach ${appId}: queued for post-session batch`);
        }
      } else {
        logger.warn("automation pipeline returned no app report", {
          service: "automation",
          action: "app_end",
          application_id: appId,
          metadata: { run_id: pipelineReport.run_id },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      noteError(
        /lease/i.test(message)
          ? "lease_held"
          : /AUTH_REQUIRED/.test(message)
            ? "jobright_auth"
            : "pipeline_error",
      );
      report.notes.push(`app ${appId} error (${lastErrorCode}): ${message.slice(0, 200)}`);
      logger.warn("automation worker: app error, continuing", {
        service: "automation",
        action: "app_error",
        application_id: appId,
        metadata: {
          code: lastErrorCode,
          error: message.slice(0, 500),
          stack:
            err instanceof Error
              ? err.stack?.split("\n").slice(0, 8).join(" | ")
              : undefined,
        },
      });
    }

    // Refresh the submit counter straight from the arm row (not via
    // getActiveArmSession, which returns nothing once the row is swept —
    // that would undercount a submit made just before expiry).
    const counts = db
      .prepare(
        `SELECT unattended_submissions_count AS n FROM automation_runs WHERE id = ?`,
      )
      .get(armRunId) as { n: number } | undefined;
    if (counts) report.submits_used = counts.n;

    appsSinceDiscover += 1;
    const ms = input.nextDelayMs
      ? input.nextDelayMs(delayRange, iter)
      : delayRange[0] + Math.floor((delayRange[1] - delayRange[0]) * ((iter % 3) / 3));
    await sleep(ms);
  }

  // Post-session referral batch: drafts only, never send; failures are
  // review items. Runs even when the arm expired mid-loop — drafting does
  // not require an armed session, only its own flags.
  for (const { appId, appResult } of tailQueue) {
    logger.info("automation outreach tail begin (batched)", {
      service: "automation",
      action: "outreach_begin",
      application_id: appId,
      metadata: { batch_size: tailQueue.length },
    });
    const tail = await runOutreachTail({
      db,
      applicationId: appId,
      headless: input.headless ?? true,
      ...(input.emailClient ? { emailClient: input.emailClient } : {}),
      ...(input.draftRunner ? { draftRunner: input.draftRunner } : {}),
      ...(input.draftVerifier ? { draftVerifier: input.draftVerifier } : {}),
    });
    appResult.outreach = {
      email_status: tail.email_status,
      draft_status: tail.draft_status,
      skip_reason:
        tail.email_status === "skipped" || tail.draft_status === "skipped"
          ? (tail.notes[0] ?? "skipped")
          : null,
    };
    if (tail.email_status === "generated") report.emails_generated += 1;
    if (tail.draft_status === "verified" || tail.draft_status === "saved") {
      report.drafts_saved += 1;
    }
    for (const n of tail.notes) report.notes.push(`outreach ${appId}: ${n}`);
    logger.info("automation outreach tail end (batched)", {
      service: "automation",
      action: "outreach_end",
      application_id: appId,
      metadata: {
        email_status: tail.email_status,
        draft_status: tail.draft_status,
        notes: tail.notes,
      },
    });
  }

  // Post-session essay draft batch: the deterministic ladder parked these
  // questions (essays are the one field class it can never answer), so the
  // AI drafts suggestions into their review items automatically — the
  // operator's remaining act is edit/approve, not compose. Fail-open.
  if (seen.size > 0) {
    const essayBatch = await generateEssayDraftBatch({
      db,
      applicationIds: [...seen],
      ...(input.essayDraftClient ? { client: input.essayDraftClient } : {}),
    });
    report.essay_drafts_generated = essayBatch.drafts_generated;
    for (const n of essayBatch.notes) report.notes.push(n);
  }

  emit();
  logger.info("automation session finished", {
    service: "automation",
    action: "session_end",
    metadata: {
      arm_run_id: armRunId,
      apps_started: report.apps_started,
      submits_used: report.submits_used,
      stopped_reason: report.stopped_reason,
      discover_runs: report.discover_runs,
      emails_generated: report.emails_generated,
      drafts_saved: report.drafts_saved,
      essay_drafts_generated: report.essay_drafts_generated,
      notes: report.notes,
      per_app: report.per_app.map((a) => ({
        application_id: a.application_id,
        end_state: a.end_state,
        stopped: a.stopped,
        stop_reason: a.stop_reason,
        submitted: a.submitted,
      })),
    },
  });
  return report;
}

function toAppResult(db: Db, appReport: PipelineAppReport): AutomationAppResult {
  const submitted =
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM submissions
           WHERE application_id = ? AND status = 'VERIFIED' AND submitted = 1`,
        )
        .get(appReport.application_id) as { n: number }
    ).n > 0;
  return {
    application_id: appReport.application_id,
    end_state: appReport.end_state,
    stopped: appReport.stopped,
    stop_reason: appReport.stop_reason,
    submitted,
    outreach: null,
  };
}
