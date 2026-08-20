import fs from "node:fs";
import { migrate, openDatabase } from "../storage/db/client.js";
import { getConfig } from "../config/index.js";
import { runPipeline } from "../pipeline/runPipeline.js";
import { runNavigation } from "../navigation/runNavigation.js";
import { runJobRightDiscovery } from "../jobright/discoveryRun.js";
import { runAutomationSession } from "../automation/worker.js";
import { runAtsSubmission } from "../applications/submitRun.js";
import {
  completeAutomationRun,
  createAutomationRun,
} from "../queue/automationRuns.js";
import { createStdioConfirm, serializeFrame } from "./frames.js";
import { GATED_FLAG_KEYS } from "./flagCeiling.js";
import { runInsiderTriage } from "../contacts/insiderTriage.js";
import { listContacts } from "../contacts/repository.js";
import { rankOutreachContacts } from "../contacts/rank.js";
import {
  generateEmailForContact,
  OUTREACH_PROMPT_VERSION,
} from "../contacts/emailGenerate.js";
import { makeLlmClient } from "../contacts/emailLlm.js";
import { createGmailDraft } from "../outreach/gmailDrafts.js";

/** Outreach loops stay bounded — a run never fans past this many contacts. */
const MAX_EMAIL_GENERATIONS_PER_RUN = 8;

/**
 * Child entrypoint for console-launched runs:
 *   tsx src/console/runner.ts <pipeline|nav|submit> --args <args.json>
 * Emits single-line control frames on stdout (hello / confirm_request /
 * report / error); everything else on stdout/stderr is log noise the
 * parent streams verbatim. The report is ALSO written to report.json next
 * to the args file, so the parent never depends on stdout demux alone.
 * Env is fully composed by the parent (flag ceiling) — this process just
 * runs the same domain functions the CLI runs.
 */

const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;

type RunnerArgs = {
  application_id?: string;
  max_applications?: number;
  headed?: boolean;
  fixture_html?: string;
  submit?: boolean;
  max_jobs?: number;
  // Automation (L3) args, injected by the run route from the arm session.
  arm_run_id?: string;
  discover_max?: number;
  rediscover_every?: number;
  report_path: string;
};

function emit(frame: Parameters<typeof serializeFrame>[0]): void {
  process.stdout.write(serializeFrame(frame));
}

async function main(): Promise<void> {
  const [kind, argsFlag, argsPath] = process.argv.slice(2);
  if (
    (kind !== "pipeline" &&
      kind !== "nav" &&
      kind !== "submit" &&
      kind !== "discover" &&
      kind !== "automation" &&
      kind !== "contacts" &&
      kind !== "email" &&
      kind !== "gmail_draft") ||
    argsFlag !== "--args" ||
    !argsPath
  ) {
    emit({
      jaa_frame: "error",
      message:
        "usage: runner <pipeline|nav|submit|discover|automation|contacts|email|gmail_draft> --args <file>",
    });
    process.exit(2);
    return;
  }
  const args = JSON.parse(fs.readFileSync(argsPath, "utf8")) as RunnerArgs;

  const cfg = getConfig();
  emit({
    jaa_frame: "hello",
    kind,
    pid: process.pid,
    // Boolean gate values only — lets the operator (and tests) verify the
    // composed ceiling from the log stream. Never raw env values.
    gates: {
      ...Object.fromEntries(
        GATED_FLAG_KEYS.map((k) => [k, process.env[k] === "true"]),
      ),
      DRY_RUN: cfg.dryRun,
    },
  });

  const db = openDatabase();
  migrate(db);
  const confirm = createStdioConfirm({
    input: process.stdin,
    output: process.stdout,
    timeoutMs: CONFIRM_TIMEOUT_MS,
  });

  let report: unknown;
  try {
    if (kind === "pipeline") {
      report = await runPipeline({
        db,
        ...(args.application_id ? { applicationId: args.application_id } : {}),
        ...(args.max_applications ? { maxApplications: args.max_applications } : {}),
        headless: !args.headed,
        ...(args.fixture_html ? { fixtureHtmlPath: args.fixture_html } : {}),
        ...(args.submit ? { submit: true } : {}),
        confirmSubmission: confirm,
      });
    } else if (kind === "nav") {
      if (!args.application_id) throw new Error("nav requires application_id");
      report = await runNavigation({
        db,
        applicationId: args.application_id,
        headless: !args.headed,
      });
    } else if (kind === "automation") {
      if (!args.arm_run_id) throw new Error("automation requires arm_run_id");
      report = await runAutomationSession({
        db,
        armRunId: args.arm_run_id,
        headless: !args.headed,
        ...(args.discover_max !== undefined ? { discoverMax: args.discover_max } : {}),
        ...(args.rediscover_every !== undefined
          ? { rediscoverEvery: args.rediscover_every }
          : {}),
        // Offline e2e seam (same as the pipeline kind): every app inspects
        // this fixture instead of the live employer page.
        ...(args.fixture_html ? { fixtureHtmlPath: args.fixture_html } : {}),
      });
    } else if (kind === "discover") {
      // Discovery opens its own DB and enqueues to QUEUED; it throws on an
      // empty live feed (after writing artifacts + a review item), which is
      // a warning here, not a run failure.
      try {
        report = await runJobRightDiscovery({
          maxJobs: args.max_jobs ?? 10,
          headless: !args.headed,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/EMPTY_FEED/.test(message)) {
          report = { jobs_inspected: 0, warning: "empty_feed", detail: message };
        } else {
          throw err;
        }
      }
    } else if (kind === "contacts") {
      // X6: Insider Connection email triage from the console — one job
      // page, bounded people cap inside triageInsiderEmails.
      if (!args.application_id) throw new Error("contacts requires application_id");
      report = await runInsiderTriage({
        db,
        applicationId: args.application_id,
        headless: !args.headed,
      });
    } else if (kind === "email") {
      // X6: generate outreach emails for every triaged contact that does
      // not already have a VALIDATED generation. Bounded by the contact
      // cap; each generation is idempotent per (app, contact, prompt).
      if (!args.application_id) throw new Error("email requires application_id");
      const contacts = rankOutreachContacts(
        listContacts(db, args.application_id),
        null,
      ).slice(0, MAX_EMAIL_GENERATIONS_PER_RUN);
      if (contacts.length === 0) {
        report = {
          generated: 0,
          note: "no contacts on this application — run insider triage first",
        };
      } else {
        const client = makeLlmClient();
        const results = [];
        for (const contact of contacts) {
          const existing = db
            .prepare(
              `SELECT validation_status FROM email_generations
               WHERE application_id = ? AND contact_id = ? AND prompt_version = ?`,
            )
            .get(args.application_id, contact.id, OUTREACH_PROMPT_VERSION) as
            | { validation_status: string }
            | undefined;
          if (existing?.validation_status === "VALIDATED") {
            results.push({ contact_id: contact.id, status: "already_validated" });
            continue;
          }
          const r = await generateEmailForContact({
            db,
            applicationId: args.application_id,
            contactId: contact.id,
            client,
          });
          results.push({
            contact_id: contact.id,
            status: r.validation_status,
            violations: r.violations,
          });
        }
        report = {
          generated: results.filter((r) => r.status === "VALIDATED").length,
          results,
        };
      }
    } else if (kind === "gmail_draft") {
      // X6: create Gmail drafts for every contact with a VALIDATED
      // generation. createGmailDraft is idempotent per (app, recipient)
      // and NEVER sends.
      if (!args.application_id) throw new Error("gmail_draft requires application_id");
      const contacts = listContacts(db, args.application_id).slice(
        0,
        MAX_EMAIL_GENERATIONS_PER_RUN,
      );
      const results = [];
      for (const contact of contacts) {
        const validated = db
          .prepare(
            `SELECT id FROM email_generations
             WHERE application_id = ? AND contact_id = ? AND validation_status = 'VALIDATED'`,
          )
          .get(args.application_id, contact.id);
        if (!validated) {
          results.push({ contact_id: contact.id, status: "no_validated_email" });
          continue;
        }
        const r = await createGmailDraft({
          db,
          applicationId: args.application_id,
          contactId: contact.id,
          headless: !args.headed,
        });
        results.push({
          contact_id: contact.id,
          status: r.status,
          verified: r.verified,
        });
      }
      report = {
        drafted: results.filter((r) => r.status === "DRAFTED").length,
        results,
      };
    } else {
      if (!args.application_id) throw new Error("submit requires application_id");
      // Own the automation run explicitly so a one-shot console submit does
      // not leave an orphan RUNNING automation_runs row (runAtsSubmission
      // would otherwise mint one and never complete it).
      const submitRun = createAutomationRun(db, { stage: "submit" });
      try {
        report = await runAtsSubmission({
          db,
          applicationId: args.application_id,
          headless: !args.headed,
          automationRunId: submitRun.id,
          confirmSubmission: confirm,
        });
      } finally {
        completeAutomationRun(db, submitRun.id);
      }
    }
  } catch (err) {
    emit({
      jaa_frame: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
    return;
  }

  fs.writeFileSync(args.report_path, JSON.stringify(report, null, 2));
  emit({ jaa_frame: "report", report });
  process.exit(0);
}

void main();
