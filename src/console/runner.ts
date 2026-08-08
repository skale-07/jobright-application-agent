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
      kind !== "automation") ||
    argsFlag !== "--args" ||
    !argsPath
  ) {
    emit({
      jaa_frame: "error",
      message: "usage: runner <pipeline|nav|submit|discover|automation> --args <file>",
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
