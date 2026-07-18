#!/usr/bin/env node
import { migrate, openDatabase, closeDatabase } from "../storage/db/client.js";
import { getConfig, deriveRolloutStage } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { listOpenReviewItems } from "../queue/reviewItems.js";
import { runLoginFlow } from "../auth/loginFlow.js";
import {
  parseServiceName,
  parseSessionMode,
  getServiceAuthConfig,
} from "../auth/serviceRegistry.js";
import { listServiceSessionRows } from "../auth/sessionStore.js";
import { describeSessionReadiness } from "../auth/serviceSession.js";
import {
  encryptSensitiveProfileFromDraft,
  sensitiveProfileStatus,
} from "../candidate/sensitiveProfileIO.js";
import { runJobRightRecorder } from "../recorder/recordFlow.js";
import { JOBRIGHT_WORKFLOWS, parseWorkflow } from "../recorder/workflows.js";
import fs from "node:fs";
import path from "node:path";
import { liveCapturesRoot } from "../recorder/workflows.js";
import {
  inspectJobById,
  runJobRightDiscovery,
} from "../jobright/discoveryRun.js";
import { evaluateEligibility } from "../jobright/eligibility.js";
import { JOBRIGHT_SELECTOR_REGISTRY_VERSION } from "../jobright/selectors/v1.js";
import {
  ATS_FIXTURE_NAMES,
  runAtsFixtureInspection,
  type AtsFixtureName,
} from "../applications/atsFixtureInspect.js";
import { inspectApplicationHtml } from "../applications/applicationInspector.js";
import { GREENHOUSE_ADAPTER_VERSION } from "../ats/greenhouse/v1.js";
import { runAtsFixtureFill } from "../applications/applicationFiller.js";
import { loadPublicProfile } from "../candidate/publicProfileIO.js";
import { resetConfigCache } from "../config/index.js";

function printHelp(): void {
  console.log(`jobright-application-agent (Phase 5)

Usage:
  npm run cli -- <command> [options]

Commands:
  --help
  migrate
  report
  login --service <jobright|linkedin|outlook> [--cdp url] [--mode ...]
  candidate:encrypt-sensitive
  record-jobright [--workflow <name>] [--all] [--derive-fixtures]
  discover [--fixture] [--max-jobs N] [--probe-detail]
  inspect --job <jobright-job-id> [--fixture]
  ats:inspect --fixture <name> | --all-fixtures | --html <path> --url <url>
  ats:fill --fixture greenhouse [--execute] [--resume path] [--cover path] [--reset]
  run --dry-run [--fixture]   Discovery only (no ATS submit)

Phase 5: Greenhouse native fill/verify/upload/reset. SUBMIT stays off.
  Plan only (default): npm run ats:fill -- --fixture greenhouse
  Execute (requires FORM_FILL_ENABLED=true DRY_RUN=false):
    npm run ats:fill -- --fixture greenhouse --execute

JobRight selector registry: ${JOBRIGHT_SELECTOR_REGISTRY_VERSION}
Greenhouse adapter: v${GREENHOUSE_ADAPTER_VERSION}
ATS fixtures: ${ATS_FIXTURE_NAMES.join(", ")}
`);
}

function notImplemented(feature: string): never {
  console.error(`Not implemented until a later phase: ${feature}`);
  process.exit(2);
}

function parseArgs(argv: string[]): {
  command: string;
  flags: Record<string, string | boolean>;
} {
  const [command = "--help", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a) continue;
    if (a === "--dry-run") {
      flags["dry-run"] = true;
      continue;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return { command, flags };
}

function cmdMigrate(): void {
  const db = openDatabase();
  try {
    const applied = migrate(db);
    if (applied.length === 0) {
      console.log("Migrations: up to date");
    } else {
      console.log(`Migrations applied: ${applied.join(", ")}`);
    }
  } finally {
    closeDatabase(db);
  }
}

function cmdReport(): void {
  const config = getConfig();
  const db = openDatabase();
  try {
    migrate(db);
    const apps = db
      .prepare(`SELECT state, COUNT(*) AS n FROM applications GROUP BY state`)
      .all();
    const openReviews = listOpenReviewItems(db);
    const sessions = listServiceSessionRows(db);
    const services = ["jobright", "linkedin", "outlook"] as const;
    const auth = services.map((service) => {
      const cfg = getServiceAuthConfig(service);
      const readiness = describeSessionReadiness(service, cfg.defaultMode);
      const row = sessions.find((s) => s.service === service);
      return {
        service,
        mode: cfg.defaultMode,
        ready: readiness.ready,
        detail: readiness.detail,
        last_status: row?.last_status ?? null,
        last_validated_at: row?.last_validated_at ?? null,
      };
    });
    const captureSummary = summarizeLiveCaptures();
    console.log(
      JSON.stringify(
        {
          database: config.databasePath,
          rollout_stage: deriveRolloutStage(config),
          dry_run: config.dryRun,
          form_fill_enabled: config.formFillEnabled,
          submit_enabled: config.submitEnabled,
          outlook_drafts_enabled: config.outlookDraftsEnabled,
          email_send_enabled: config.emailSendEnabled,
          applications_by_state: apps,
          open_review_items: openReviews.length,
          auth,
          sensitive_profile: sensitiveProfileStatus(),
          live_captures: captureSummary,
        },
        null,
        2,
      ),
    );
  } finally {
    closeDatabase(db);
  }
}

async function cmdLogin(flags: Record<string, string | boolean>): Promise<void> {
  const serviceRaw = flags["service"];
  if (typeof serviceRaw !== "string") {
    console.error(
      "Usage: login --service <jobright|linkedin|outlook> [--mode ...] [--cdp http://127.0.0.1:9222]",
    );
    process.exit(1);
  }
  const service = parseServiceName(serviceRaw);
  const mode =
    typeof flags["mode"] === "string" ? parseSessionMode(flags["mode"]) : undefined;
  const cdp =
    typeof flags["cdp"] === "string"
      ? flags["cdp"]
      : flags["cdp"] === true
        ? "http://127.0.0.1:9222"
        : undefined;
  await runLoginFlow({
    service,
    ...(mode ? { mode } : {}),
    ...(cdp ? { cdpUrl: cdp } : {}),
  });
}

function cmdEncryptSensitive(): void {
  const result = encryptSensitiveProfileFromDraft();
  console.log(`Encrypted sensitive profile → ${result.encPath}`);
  console.log("Draft plaintext deleted.");
}

function summarizeLiveCaptures(): Record<string, number> {
  const root = liveCapturesRoot();
  const summary: Record<string, number> = {};
  for (const workflow of JOBRIGHT_WORKFLOWS) {
    const dir = path.join(root, workflow);
    if (!fs.existsSync(dir)) {
      summary[workflow] = 0;
      continue;
    }
    summary[workflow] = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory()).length;
  }
  return summary;
}

async function cmdRecordJobright(
  flags: Record<string, string | boolean>,
): Promise<void> {
  let workflows = [...JOBRIGHT_WORKFLOWS];
  if (typeof flags["workflow"] === "string") {
    workflows = [parseWorkflow(flags["workflow"])];
  } else if (!flags["all"]) {
    // Default: single interactive pass starting with job-feed only is safer;
    // require --all for full suite to avoid accidental long sessions.
    workflows = ["job-feed"];
    console.log(
      "Recording default workflow job-feed. Pass --all or --workflow <name> to change.",
    );
  }

  await runJobRightRecorder({
    workflows,
    deriveFixtures: Boolean(flags["derive-fixtures"]),
  });
}

async function cmdDiscover(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const maxJobs =
    typeof flags["max-jobs"] === "string" ? Number(flags["max-jobs"]) : 10;
  const feedHtmlPath = flags["fixture"]
    ? path.join(
        process.cwd(),
        "tests",
        "fixtures",
        "jobright",
        "job-feed",
        "dom.sanitized.html",
      )
    : undefined;

  const report = await runJobRightDiscovery({
    ...(feedHtmlPath ? { feedHtmlPath } : {}),
    maxJobs: Number.isFinite(maxJobs) ? maxJobs : 10,
    openJobDetails: Boolean(flags["probe-detail"]) && !flags["fixture"],
    headless: false,
  });
  console.log(JSON.stringify(report, null, 2));
}

async function cmdInspect(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const jobId = flags["job"];
  if (typeof jobId !== "string") {
    console.error("Usage: inspect --job <jobright-job-id> [--fixture]");
    process.exit(1);
  }
  const feedHtmlPath = flags["fixture"]
    ? path.join(
        process.cwd(),
        "tests",
        "fixtures",
        "jobright",
        "job-feed",
        "dom.sanitized.html",
      )
    : undefined;
  const card = await inspectJobById({
    jobId,
    ...(feedHtmlPath ? { feedHtmlPath } : {}),
  });
  if (!card) {
    console.error(`Job not found: ${jobId}`);
    process.exit(1);
  }
  const eligibility = evaluateEligibility({
    role: card.role,
    employmentType: card.employment_type,
    description: card.role,
  });
  console.log(JSON.stringify({ card, eligibility }, null, 2));
}

async function cmdAtsInspect(
  flags: Record<string, string | boolean>,
): Promise<void> {
  if (flags["all-fixtures"]) {
    const results = [];
    for (const name of ATS_FIXTURE_NAMES) {
      const { reportPath, report } = await runAtsFixtureInspection(name);
      results.push({
        fixture: name,
        ats: report.inspection.ats,
        route: report.route,
        fields: report.inspection.fields.length,
        report_path: reportPath,
      });
    }
    console.log(JSON.stringify({ fixtures: results }, null, 2));
    return;
  }

  if (typeof flags["fixture"] === "string") {
    const name = flags["fixture"] as AtsFixtureName;
    if (!ATS_FIXTURE_NAMES.includes(name)) {
      console.error(
        `Unknown fixture "${name}". Expected one of: ${ATS_FIXTURE_NAMES.join(", ")}`,
      );
      process.exit(1);
    }
    const { reportPath, report } = await runAtsFixtureInspection(name);
    console.log(JSON.stringify({ report_path: reportPath, ...report }, null, 2));
    return;
  }

  const htmlPath = flags["html"];
  const url = flags["url"];
  if (typeof htmlPath === "string" && typeof url === "string") {
    const html = fs.readFileSync(path.resolve(htmlPath), "utf8");
    const report = await inspectApplicationHtml({
      url,
      html,
      ...(typeof flags["title"] === "string" ? { title: flags["title"] } : {}),
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.error(
    "Usage: ats:inspect --fixture <name> | --all-fixtures | --html <path> --url <url>",
  );
  process.exit(1);
}

async function cmdAtsFill(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const fixture = flags["fixture"];
  if (fixture !== "greenhouse") {
    console.error(
      'Usage: ats:fill --fixture greenhouse [--execute] [--resume path] [--cover path] [--reset]',
    );
    process.exit(1);
  }

  // Allow --execute to force re-read of env if caller set vars in-shell
  resetConfigCache();

  const execute = Boolean(flags["execute"]);
  const resumePath =
    typeof flags["resume"] === "string" ? flags["resume"] : undefined;
  const coverPath =
    typeof flags["cover"] === "string" ? flags["cover"] : undefined;

  // Prefer real public-profile.json; fall back to example with sponsorship filled for demos
  let profile = loadPublicProfile();
  if (!profile.requires_sponsorship) {
    profile = {
      ...profile,
      requires_sponsorship: "No",
    };
  }

  const report = await runAtsFixtureFill("greenhouse", {
    execute,
    profile,
    ...(resumePath ? { resumePath } : {}),
    ...(coverPath ? { coverLetterPath: coverPath } : {}),
    resetAfter: Boolean(flags["reset"]),
  });
  console.log(JSON.stringify(report, null, 2));
  if (execute && report.verify && !report.verify.passed) {
    process.exitCode = 2;
  }
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));

  switch (command) {
    case "--help":
    case "help":
      printHelp();
      return;
    case "migrate":
      cmdMigrate();
      return;
    case "report":
      cmdReport();
      return;
    case "login":
      await cmdLogin(flags);
      return;
    case "candidate:encrypt-sensitive":
      cmdEncryptSensitive();
      return;
    case "record-jobright":
      await cmdRecordJobright(flags);
      return;
    case "discover":
      await cmdDiscover(flags);
      return;
    case "inspect":
      await cmdInspect(flags);
      return;
    case "ats:inspect":
      await cmdAtsInspect(flags);
      return;
    case "ats:fill":
      await cmdAtsFill(flags);
      return;
    case "run":
      if (flags["dry-run"] || getConfig().dryRun) {
        await cmdDiscover({ ...flags, fixture: flags["fixture"] ?? false });
        return;
      }
      notImplemented("live run with submit (later phases; SUBMIT_ENABLED required)");
      break;
    case "dashboard":
      notImplemented("dashboard (Phase 13)");
      break;
    case "retry":
      notImplemented("retry (Phase 7+)");
      break;
    case "resume-essay":
      notImplemented("resume-essay (Phase 8)");
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
