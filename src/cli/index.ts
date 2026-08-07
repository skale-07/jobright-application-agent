#!/usr/bin/env node
import { migrate, openDatabase, closeDatabase } from "../storage/db/client.js";
import {
  exportFillOutcomesJsonl,
  summarizeFillOutcomes,
} from "../storage/fillOutcomes.js";
import { getConfig, deriveRolloutStage } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { listOpenReviewItems, resolveReviewItem } from "../queue/reviewItems.js";
import { getApplication, transitionApplication } from "../queue/stateMachine.js";
import {
  ESSAY_REVIEW_TITLE,
  listHumanEssayAnswers,
  saveHumanEssayAnswer,
  unansweredEssayFieldKeys,
} from "../applications/essayAnswers.js";
import { runAtsSubmission } from "../applications/submitRun.js";
import { runAtsLiveFill } from "../applications/atsLiveFill.js";
import { ATS_BINDINGS } from "../applications/atsBindings.js";
import { detectAtsFromUrl } from "../ats/shared/urlValidationDispatch.js";
import { waitForRenderedContent } from "../ats/shared/preMutationGate.js";
import { ashbySelectorsV1 } from "../ats/ashby/selectors.js";
import { leverSelectorsV1 } from "../ats/lever/selectors.js";
import { withPublicUrlPage } from "../browser/fixtureSession.js";
import { writeJsonAtomic } from "../storage/atomicJson.js";
import {
  retryFailedApplications,
  runPipeline,
  setEmployerApplicationUrl,
} from "../pipeline/runPipeline.js";
import { runContactsExtraction } from "../contacts/extractContacts.js";
import { createOutlookDraft, verifyOutlookDraft } from "../outlook/draftRun.js";
import { startDashboard } from "../dashboard/server.js";
import { runAgentAuthoring } from "../agent/authorRun.js";
import { buildReportSummary } from "../dashboard/reportData.js";
import { listContacts } from "../contacts/repository.js";
import { generateEmailForContact } from "../contacts/emailGenerate.js";
import { OpenAiEmailClient } from "../contacts/emailLlm.js";
import {
  getLatestUncertainSubmission,
  markSubmissionFailed,
  markSubmissionVerified,
} from "../queue/submissionsRepo.js";
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
import { runJobRightDiscovery } from "../jobright/discoveryRun.js";
import { enqueueJobRightJobs } from "../jobright/enqueueJobs.js";
import { runJobrightResumeDownload } from "../jobright/resumeDownloadRun.js";
import { registerResumeMaterial } from "../jobright/materialsRegister.js";
import { runGreenhouseLiveFill } from "../ats/greenhouse/liveFill.js";
import { JOBRIGHT_SELECTOR_REGISTRY_VERSION } from "../jobright/selectors/v1.js";
import {
  formatInspectionConsole,
  inspectStoredJobrightJob,
  StoredJobInspectionError,
} from "../jobright/inspectStoredJob.js";
import {
  ATS_FIXTURE_NAMES,
  runAtsFixtureInspection,
  type AtsFixtureName,
} from "../applications/atsFixtureInspect.js";
import { inspectApplicationHtml } from "../applications/applicationInspector.js";
import {
  formatGreenhouseInspectConsole,
  GreenhouseLiveInspectError,
  inspectGreenhouseApplication,
} from "../ats/greenhouse/liveInspect.js";
import { GREENHOUSE_ADAPTER_VERSION } from "../ats/greenhouse/v1.js";
import { LEVER_ADAPTER_VERSION } from "../ats/lever/v1.js";
import { ASHBY_ADAPTER_VERSION } from "../ats/ashby/v1.js";
import {
  FILLABLE_FIXTURE_NAMES,
  runAtsFixtureFill,
} from "../applications/applicationFiller.js";
import { redactFillReportForArtifact } from "../applications/fillReportRedaction.js";
import { loadPublicProfile } from "../candidate/publicProfileIO.js";
import { resetConfigCache } from "../config/index.js";
import { promoteFixture } from "../recorder/promoteFixture.js";

function printHelp(): void {
  console.log(`jobright-application-agent (Phase 5.5)

Usage:
  npm run cli -- <command> [options]

Commands:
  --help
  migrate
  report
  login --service <jobright|linkedin|outlook> [--cdp url] [--mode ...]
  candidate:encrypt-sensitive
  record-jobright [--workflow <name>] [--all] [--derive-fixtures]
  recorder:promote --run <runId> --workflow <name> [--force]
  discover [--fixture] [--max-jobs N] [--probe-detail]
  enqueue --jobright <url|id> [--jobright ...] [--file path] [--employer-url <ats-apply-url (greenhouse|lever|ashby)>]
  inspect --job <jobright_job_id> [--application <uuid>] [--fixture] [--save-diagnostics]
  ats:inspect --url <ATS_APPLICATION_URL (greenhouse|lever|ashby)> [--headed] [--save-diagnostics]
  ats:inspect --fixture <name> | --all-fixtures | --html <path> --url <url>
  ats:fill --fixture <greenhouse|essay|lever|ashby> [--execute] [--resume path] [--cover path] [--reset]
  ats:fill --url <ATS_APPLICATION_URL (greenhouse|lever|ashby)> [--execute] [--resume path] [--headed]
  ats:fill-outcomes [--summary] [--export <path.jsonl>]
  resume:download --job <jobright_job_id> [--yes] [--headless]
  materials:register --application <uuid> --file <path.pdf> [--label domain]
  resume-essay [--application <uuid> --field <field_id> --file <answer.txt>]
  submit --application <uuid> [--headed] [--yes]
  review
  review:resolve --id <review_item_id> --outcome submitted|not-submitted [--requeue]
  run --pipeline [--app <uuid>] [--url <employer_url>] [--max N] [--submit] [--headed] [--fixture-html <path>]
  retry
  contacts:extract --application <uuid> [--fixture <html-path>] [--headed]
  email:generate --application <uuid> [--contact <id>] [--persona <id>]
  draft:create --application <uuid> --contact <contact_id> [--headed]
  draft:verify --draft <draft_id> [--headed]
  dashboard
  agent:author --url <GREENHOUSE_APPLICATION_URL> [--cdp <url>]
  run --dry-run [--fixture]   Discovery only (no ATS submit)

Phase 5.5: resume download orchestration, recorder promote, secrets allowlist.
  Promote sanitized live-captures only (excludes screenshots):
    npm run recorder:promote -- --run <runId> --workflow job-feed
  Overwrite existing derived fixtures:
    npm run recorder:promote -- --run <runId> --workflow job-feed --force

Greenhouse fill/verify/upload/reset. SUBMIT stays off.
  Plan only (default): npm run ats:fill -- --fixture greenhouse
  Execute (requires FORM_FILL_ENABLED=true DRY_RUN=false):
    npm run ats:fill -- --fixture greenhouse --execute

Field-fill outcome corpus (local SQLite):
  npm run ats:fill-outcomes -- --summary
  npm run ats:fill-outcomes -- --export artifacts/fill-outcomes.jsonl

Greenhouse live read-only inspection:
  Read-only inspection only.
  Does not fill, upload, click Submit, or mutate the application.
  Requires DRY_RUN=true, FORM_FILL_ENABLED=false, SUBMIT_ENABLED=false.
  Example:
    npm run ats:inspect -- --url https://boards.greenhouse.io/acme/jobs/12345

JobRight stored-job inspection (deterministic; SQLite → detail URL; read-only):
  --job <jobright_job_id>    Inspect a persisted JobRight job by its JobRight ID
                            (not an application UUID)
  --application <uuid>      Optional: resolve via application UUID → job
  Requires FORM_FILL_ENABLED=false DRY_RUN=true SUBMIT_ENABLED=false
  Example:
    npm run inspect -- --job 6a0fad5383d7144289822170
  Offline fixture detail page (no live JobRight):
    npm run inspect -- --job <jobright_job_id> --fixture

JobRight selector registry: ${JOBRIGHT_SELECTOR_REGISTRY_VERSION}
ATS adapters: greenhouse v${GREENHOUSE_ADAPTER_VERSION}, lever v${LEVER_ADAPTER_VERSION}, ashby v${ASHBY_ADAPTER_VERSION}
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
  const db = openDatabase();
  try {
    migrate(db);
    // Shared with the dashboard (src/dashboard/reportData.ts) so the two
    // can never disagree; live_captures stays CLI-only.
    console.log(
      JSON.stringify(
        {
          ...buildReportSummary(db),
          live_captures: summarizeLiveCaptures(),
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

/**
 * Collect repeated --jobright / --url values (parseArgs only keeps the last).
 * Also reads optional --file (one ref per line).
 */
function collectEnqueueRefs(argv: string[]): {
  refs: string[];
  employerUrl: string | undefined;
  filePath: string | undefined;
} {
  const refs: string[] = [];
  let employerUrl: string | undefined;
  let filePath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (
      (a === "--jobright" || a === "--url" || a === "--job") &&
      argv[i + 1] &&
      !argv[i + 1]!.startsWith("--")
    ) {
      refs.push(argv[i + 1]!);
      i++;
      continue;
    }
    if (a === "--employer-url" && argv[i + 1] && !argv[i + 1]!.startsWith("--")) {
      employerUrl = argv[i + 1];
      i++;
      continue;
    }
    if (a === "--file" && argv[i + 1] && !argv[i + 1]!.startsWith("--")) {
      filePath = argv[i + 1];
      i++;
      continue;
    }
  }
  return { refs, employerUrl, filePath };
}

function cmdEnqueue(): void {
  // Skip command name; argv is full process args in main — pass rest from caller
  const raw = process.argv.slice(3);
  const { refs: flagRefs, employerUrl, filePath } = collectEnqueueRefs(raw);
  const refs = [...flagRefs];

  if (filePath) {
    const abs = path.resolve(filePath);
    if (!fs.existsSync(abs)) {
      console.error(`File not found: ${abs}`);
      process.exit(2);
      return;
    }
    refs.push(
      ...fs
        .readFileSync(abs, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("#")),
    );
  }

  if (refs.length === 0) {
    console.error(`Usage:
  enqueue --jobright <jobright-url-or-id> [--jobright ...]
  enqueue --jobright <id> --employer-url <ats-apply-url (greenhouse|lever|ashby)>
  enqueue --file jobs.txt

Each line in jobs.txt is a JobRight detail URL or bare hex job id.
Prints application UUID(s) — required for materials:register / submit.`);
    process.exit(2);
    return;
  }

  if (employerUrl && refs.length > 1) {
    console.error(
      "Refusing --employer-url with multiple JobRight refs (one Greenhouse apply URL cannot map to many jobs).",
    );
    process.exit(2);
    return;
  }

  const db = openDatabase();
  try {
    migrate(db);
    const report = enqueueJobRightJobs(db, refs, {
      ...(employerUrl ? { employerApplicationUrl: employerUrl } : {}),
    });
    console.log(JSON.stringify(report, null, 2));
    if (report.failed > 0 || report.blocked > 0) {
      process.exitCode = report.enqueued + report.reused > 0 ? 3 : 1;
    }
  } finally {
    closeDatabase(db);
  }
}

async function cmdInspect(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const jobId = flags["job"];
  const applicationId = flags["application"];
  if (typeof jobId !== "string" && typeof applicationId !== "string") {
    console.error(
      "Usage: inspect --job <jobright_job_id> | --application <uuid> [--fixture] [--save-diagnostics]",
    );
    console.error(
      "  --job accepts a JobRight job ID (e.g. 6a0fad5383d7144289822170), not an application UUID.",
    );
    process.exit(1);
  }

  const fixtureDetailHtmlPath = flags["fixture"]
    ? path.join(
        process.cwd(),
        "tests",
        "fixtures",
        "jobright",
        "job-detail",
        "dom.sanitized.html",
      )
    : undefined;

  try {
    const report = await inspectStoredJobrightJob({
      ...(typeof jobId === "string" ? { jobrightJobId: jobId } : {}),
      ...(typeof applicationId === "string"
        ? { applicationId }
        : {}),
      ...(fixtureDetailHtmlPath ? { fixtureDetailHtmlPath } : {}),
      headless: Boolean(flags["fixture"]),
      saveDiagnostics: Boolean(flags["save-diagnostics"]),
    });
    console.log(formatInspectionConsole(report));
  } catch (err) {
    if (err instanceof StoredJobInspectionError) {
      if (
        err.report.identity_verification &&
        !err.report.identity_verification.passed
      ) {
        const idv = err.report.identity_verification;
        console.error("JobRight identity verification failed.");
        console.error(`Requested: ${idv.requestedJobrightJobId}`);
        console.error(`Observed: ${idv.parsedJobrightJobId ?? "null"}`);
        console.error("No controls were activated.");
        if (idv.failureReason) console.error(idv.failureReason);
      } else if (err.message.includes("Stored JobRight job not found")) {
        console.error(`Stored JobRight job not found: ${jobId ?? applicationId}`);
        console.error("Run discovery first or verify the job ID.");
      } else {
        console.error(err.message);
      }
      if (err.report.artifact_path) {
        console.error(`Artifact: ${err.report.artifact_path}`);
      }
      process.exit(err.exitCode);
    }
    throw err;
  }
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

  // Offline: saved HTML + URL metadata
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

  // Live read-only: URL only (no --html)
  if (typeof url === "string" && htmlPath === undefined) {
    const detected = detectAtsFromUrl(url);
    if (detected.ats !== null && detected.ats !== "greenhouse") {
      // Lever/Ashby: fetch the rendered DOM read-only, then run the same
      // offline inspection used for --html. Ashby is a SPA — wait for
      // rendered form controls, not just domcontentloaded.
      const renderMarker =
        detected.ats === "ashby"
          ? ashbySelectorsV1.renderedFormMarkers
          : leverSelectorsV1.formMarkers;
      const report = await withPublicUrlPage(
        detected.normalizedUrl,
        async (page) =>
          inspectApplicationHtml({
            url: page.url(),
            html: await waitForRenderedContent(page, renderMarker),
            title: await page.title().catch(() => ""),
          }),
        { headless: !flags["headed"] },
      );
      const cfg = getConfig();
      const outDir = path.join(cfg.artifactsDir, "ats-inspect", `${detected.ats}-live`);
      fs.mkdirSync(outDir, { recursive: true });
      const reportPath = path.join(outDir, `inspect-${Date.now()}.json`);
      writeJsonAtomic(reportPath, { ...report, written_at: new Date().toISOString() });
      console.log(JSON.stringify({ report_path: reportPath, ...report }, null, 2));
      return;
    }
    try {
      const report = await inspectGreenhouseApplication({
        url,
        headless: !Boolean(flags["headed"]),
        saveDiagnostics: Boolean(flags["save-diagnostics"]),
      });
      console.log(formatGreenhouseInspectConsole(report));
    } catch (err) {
      if (err instanceof GreenhouseLiveInspectError) {
        console.error(formatGreenhouseInspectConsole(err.report));
        process.exit(err.exitCode);
      }
      throw err;
    }
    return;
  }

  console.error(
    "Usage: ats:inspect --url <ATS_APPLICATION_URL (greenhouse|lever|ashby)> [--headed] [--save-diagnostics]",
  );
  console.error(
    "   or: ats:inspect --fixture <name> | --all-fixtures | --html <path> --url <url>",
  );
  console.error(
    "Read-only inspection only. Does not fill, upload, click Submit, or mutate the application.",
  );
  console.error(
    "Requires DRY_RUN=true, FORM_FILL_ENABLED=false, SUBMIT_ENABLED=false.",
  );
  process.exit(1);
}

/** Post-submit: extract JobRight contacts for one application. */
async function cmdContactsExtract(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const application = flags["application"];
  if (typeof application !== "string") {
    console.error(
      "Usage: contacts:extract --application <uuid> [--fixture <html-path>] [--headed]",
    );
    process.exit(2);
    return;
  }
  const db = openDatabase();
  try {
    migrate(db);
    const report = await runContactsExtraction({
      db,
      applicationId: application,
      ...(typeof flags["fixture"] === "string"
        ? { fixtureHtmlPath: flags["fixture"] }
        : {}),
      headless: flags["headed"] !== true,
    });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    closeDatabase(db);
  }
}

/**
 * Outreach generation (the only LLM boundary in this codebase).
 * Prints the generated email for inspection; the Outlook Drafts folder is
 * the final human review surface.
 */
async function cmdEmailGenerate(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const application = flags["application"];
  if (typeof application !== "string") {
    console.error(
      "Usage: email:generate --application <uuid> [--contact <id>] [--persona <id>]",
    );
    console.error(
      "Requires EMAIL_GENERATION_ENABLED=true and OPENAI_API_KEY in .env.",
    );
    process.exit(2);
    return;
  }
  const db = openDatabase();
  try {
    migrate(db);
    const contacts = listContacts(db, application);
    const targets =
      typeof flags["contact"] === "string"
        ? contacts.filter((c) => c.id === flags["contact"])
        : contacts;
    if (targets.length === 0) {
      console.error(
        "No matching contacts — run contacts:extract first (or check --contact id).",
      );
      process.exit(1);
      return;
    }
    const client = new OpenAiEmailClient();
    const results = [];
    for (const contact of targets) {
      results.push(
        await generateEmailForContact({
          db,
          applicationId: application,
          contactId: contact.id,
          client,
          ...(typeof flags["persona"] === "string"
            ? { personaId: flags["persona"] }
            : {}),
        }),
      );
    }
    console.log(JSON.stringify(results, null, 2));
    if (results.some((r) => r.validation_status === "REJECTED")) {
      process.exitCode = 3;
    }
  } finally {
    closeDatabase(db);
  }
}

/** Phase 7+: sequential pipeline driver. Submission stays behind its own gates. */
async function cmdRunPipeline(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const db = openDatabase();
  try {
    migrate(db);
    const app = typeof flags["app"] === "string" ? flags["app"] : undefined;
    const url = typeof flags["url"] === "string" ? flags["url"] : undefined;
    if (url) {
      if (!app) {
        console.error("--url requires --app <uuid> to know which job it belongs to");
        process.exit(2);
        return;
      }
      setEmployerApplicationUrl(db, app, url);
      console.log(`Stored employer application URL for ${app}`);
    }
    const report = await runPipeline({
      db,
      ...(app ? { applicationId: app } : {}),
      maxApplications:
        typeof flags["max"] === "string" ? Number(flags["max"]) : 1,
      headless: flags["headed"] !== true,
      ...(typeof flags["fixture-html"] === "string"
        ? { fixtureHtmlPath: flags["fixture-html"] }
        : {}),
      submit: flags["submit"] === true,
      assumeYes: flags["yes"] === true,
    });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    closeDatabase(db);
  }
}

/** Phase 7: human-approved submission. All gates live in runAtsSubmission. */
async function cmdSubmit(flags: Record<string, string | boolean>): Promise<void> {
  const application = flags["application"];
  if (typeof application !== "string") {
    console.error("Usage: submit --application <uuid> [--headed] [--yes]");
    console.error(
      "Requires FORM_FILL_ENABLED=true DRY_RUN=false SUBMIT_ENABLED=true.",
    );
    process.exit(2);
    return;
  }
  const db = openDatabase();
  try {
    migrate(db);
    const report = await runAtsSubmission({
      db,
      applicationId: application,
      headless: flags["headed"] !== true,
      assumeYes: flags["yes"] === true,
    });
    console.log(JSON.stringify(report, null, 2));
    if (report.outcome !== "SUBMITTED_VERIFIED") {
      process.exitCode = report.outcome === "UNCERTAIN" ? 3 : 1;
    }
  } finally {
    closeDatabase(db);
  }
}

function cmdReview(): void {
  const db = openDatabase();
  try {
    migrate(db);
    const items = listOpenReviewItems(db);
    console.log(
      JSON.stringify(
        items.map((i) => ({
          id: i.id,
          kind: i.kind,
          application_id: i.application_id,
          title: i.title,
          created_at: i.created_at,
          payload: JSON.parse(i.payload_json),
        })),
        null,
        2,
      ),
    );
  } finally {
    closeDatabase(db);
  }
}

/**
 * Operator resolution of an uncertain submission.
 * --outcome submitted      : receipt confirmed to exist → SUBMITTED
 * --outcome not-submitted  : confirmed nothing went through; --requeue for retry
 */
function cmdReviewResolve(flags: Record<string, string | boolean>): void {
  const id = flags["id"];
  const outcome = flags["outcome"];
  if (
    typeof id !== "string" ||
    (outcome !== "submitted" && outcome !== "not-submitted")
  ) {
    console.error(
      "Usage: review:resolve --id <review_item_id> --outcome submitted|not-submitted [--requeue]",
    );
    process.exit(2);
    return;
  }
  const db = openDatabase();
  try {
    migrate(db);
    const item = listOpenReviewItems(db).find((i) => i.id === id);
    if (!item) {
      console.error(`No open review item with id ${id}`);
      process.exit(1);
      return;
    }
    if (item.kind !== "UNCERTAIN_SUBMISSION" || !item.application_id) {
      console.error(
        `review:resolve currently handles UNCERTAIN_SUBMISSION items only (got ${item.kind})`,
      );
      process.exit(1);
      return;
    }
    const applicationId = item.application_id;
    const uncertain = getLatestUncertainSubmission(db, applicationId);

    if (outcome === "submitted") {
      if (uncertain) {
        markSubmissionVerified(db, uncertain.id, {
          submitted: true,
          submitted_at: new Date().toISOString(),
          confirmation_url: "operator://review-resolve",
          confirmation_text: "Operator confirmed receipt exists",
          application_identifier: null,
          screenshot_path: uncertain.screenshot_path ?? "",
        });
      }
      transitionApplication(db, {
        applicationId,
        nextState: "SUBMITTED",
        reason: "operator confirmed submission receipt (review:resolve)",
      });
      resolveReviewItem(db, id, { outcome: "submitted", by: "review:resolve" });
      console.log(
        JSON.stringify({ resolved: id, outcome, state: "SUBMITTED" }, null, 2),
      );
      return;
    }

    // not-submitted
    if (uncertain) {
      markSubmissionFailed(
        db,
        uncertain.id,
        "operator confirmed nothing was submitted",
      );
    }
    transitionApplication(db, {
      applicationId,
      nextState: "FAILED_RETRYABLE",
      reason: "operator confirmed no submission occurred (review:resolve)",
    });
    if (flags["requeue"] === true) {
      transitionApplication(db, {
        applicationId,
        nextState: "QUEUED",
        reason: "operator requeue after uncertain resolution",
      });
    }
    resolveReviewItem(db, id, {
      outcome: "not-submitted",
      requeued: flags["requeue"] === true,
      by: "review:resolve",
    });
    console.log(
      JSON.stringify(
        {
          resolved: id,
          outcome,
          state: flags["requeue"] === true ? "QUEUED" : "FAILED_RETRYABLE",
        },
        null,
        2,
      ),
    );
  } finally {
    closeDatabase(db);
  }
}

/**
 * Phase 8: human-authored essay answers for ATS-form free-text questions.
 * Distinct from outreach email generation — essays are never machine-written.
 */
function cmdResumeEssay(flags: Record<string, string | boolean>): void {
  const application = flags["application"];
  const field = flags["field"];
  const file = flags["file"];

  const db = openDatabase();
  try {
    migrate(db);

    // List mode: what still needs writing.
    if (typeof application !== "string") {
      const items = listOpenReviewItems(db).filter(
        (i) => i.kind === "ESSAY",
      );
      const apps = db
        .prepare(
          `SELECT a.id, a.state, j.company, j.role FROM applications a
           JOIN jobs j ON j.id = a.job_id
           WHERE a.state = 'ESSAY_REQUIRED'`,
        )
        .all() as Array<{
        id: string;
        state: string;
        company: string;
        role: string;
      }>;
      console.log(
        JSON.stringify(
          {
            essay_required_applications: apps,
            open_essay_review_items: items.map((i) => ({
              id: i.id,
              application_id: i.application_id,
              essays: JSON.parse(i.payload_json),
            })),
            usage:
              "resume-essay --application <uuid> --field <field_id> --file <answer.txt>",
          },
          null,
          2,
        ),
      );
      return;
    }

    if (typeof field !== "string" || typeof file !== "string") {
      console.error(
        "Usage: resume-essay --application <uuid> --field <field_id> --file <answer.txt>",
      );
      process.exit(2);
      return;
    }

    const app = getApplication(db, application);
    if (!app) {
      console.error(`Unknown application: ${application}`);
      process.exit(1);
      return;
    }

    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) {
      console.error(`Answer file not found: ${abs}`);
      process.exit(1);
      return;
    }
    const text = fs.readFileSync(abs, "utf8");
    const saved = saveHumanEssayAnswer(db, {
      applicationId: application,
      fieldKey: field,
      text,
      sourceFile: abs,
    });

    // When every essay the review item asked for has an answer, resolve it
    // and move the application back toward verification.
    const essayItems = listOpenReviewItems(db).filter(
      (i) => i.kind === "ESSAY" && i.application_id === application,
    );
    let resolved = false;
    let remaining: string[] = [];
    for (const item of essayItems) {
      remaining = unansweredEssayFieldKeys(db, application, item);
      if (remaining.length === 0) {
        resolveReviewItem(db, item.id, {
          resolved_by: "resume-essay",
          answers: listHumanEssayAnswers(db, application).map((a) => ({
            field_key: a.field_key,
            chars: a.text.length,
          })),
        });
        resolved = true;
      }
    }
    if (
      resolved &&
      getApplication(db, application)?.state === "ESSAY_REQUIRED"
    ) {
      transitionApplication(db, {
        applicationId: application,
        nextState: "FIELD_VERIFICATION",
        reason: "all essay answers provided via resume-essay",
      });
    }

    console.log(
      JSON.stringify(
        {
          answer_id: saved.id,
          field_key: field,
          chars: text.trim().length,
          review_item_title: ESSAY_REVIEW_TITLE,
          review_resolved: resolved,
          unanswered_fields: remaining,
          application_state: getApplication(db, application)?.state,
        },
        null,
        2,
      ),
    );
  } finally {
    closeDatabase(db);
  }
}

function cmdMaterialsRegister(flags: Record<string, string | boolean>): void {
  const application = flags["application"];
  const file = flags["file"];
  if (typeof application !== "string" || typeof file !== "string") {
    console.error(
      "Usage: materials:register --application <uuid> --file <path.pdf> [--label domain]",
    );
    console.error(
      "Registers a pre-written domain resume as this application's verified resume material.",
    );
    process.exit(2);
    return;
  }
  const db = openDatabase();
  try {
    migrate(db);
    const result = registerResumeMaterial({
      db,
      applicationId: application,
      filePath: file,
      ...(typeof flags["label"] === "string" ? { label: flags["label"] } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    closeDatabase(db);
  }
}

async function cmdResumeDownload(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const job = flags["job"];
  if (typeof job !== "string" || job.trim() === "") {
    console.error(
      "Usage: resume:download --job <jobright_job_id> [--yes] [--headless]",
    );
    console.error(
      "Generates a resume on live JobRight. Requires MATERIALS_DOWNLOAD_ENABLED=true and DRY_RUN=false.",
    );
    process.exit(2);
    return;
  }
  const report = await runJobrightResumeDownload({
    jobrightJobId: job.trim(),
    headless: flags["headless"] === true,
    assumeYes: flags["yes"] === true,
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.verified && report.status !== "skipped") {
    process.exit(1);
  }
}

async function cmdAtsFill(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const fixture = flags["fixture"];
  const url = flags["url"];
  if (
    typeof url !== "string" &&
    !(typeof fixture === "string" && FILLABLE_FIXTURE_NAMES.includes(fixture))
  ) {
    console.error(
      `Usage: ats:fill --fixture <${FILLABLE_FIXTURE_NAMES.join("|")}> [--execute] [--resume path] [--cover path] [--reset]`,
    );
    console.error(
      "   or: ats:fill --url <ATS_APPLICATION_URL (greenhouse|lever|ashby)> [--execute] [--resume path] [--headed]",
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

  if (typeof url === "string") {
    const detected = detectAtsFromUrl(url);
    if (detected.ats === null) {
      console.error(`ats:fill refused: ${detected.failureReason}`);
      process.exit(1);
    }
    const profileForLive = loadPublicProfile();
    if (detected.ats === "greenhouse") {
      const liveReport = await runGreenhouseLiveFill({
        url,
        execute,
        profile: profileForLive,
        ...(resumePath ? { resumePath } : {}),
        ...(coverPath ? { coverLetterPath: coverPath } : {}),
        headless: flags["headed"] !== true,
      });
      console.log(
        JSON.stringify(redactFillReportForArtifact(liveReport), null, 2),
      );
      if (execute && liveReport.verify && !liveReport.verify.passed) {
        process.exitCode = 2;
      }
      return;
    }
    const liveReport = await runAtsLiveFill({
      binding: ATS_BINDINGS[detected.ats],
      url,
      execute,
      profile: profileForLive,
      ...(resumePath ? { resumePath } : {}),
      headless: flags["headed"] !== true,
    });
    if (coverPath) {
      console.error(
        `note: --cover ignored — ${detected.ats} has no cover-letter file input`,
      );
    }
    console.log(
      JSON.stringify(redactFillReportForArtifact(liveReport), null, 2),
    );
    if (execute && (!liveReport.gate.ok || !liveReport.verify?.passed)) {
      process.exitCode = 2;
    }
    return;
  }

  // Prefer real public-profile.json; do not invent sponsorship answers
  const profile = loadPublicProfile();

  const report = await runAtsFixtureFill(fixture as AtsFixtureName, {
    execute,
    profile,
    ...(resumePath ? { resumePath } : {}),
    ...(coverPath ? { coverLetterPath: coverPath } : {}),
    resetAfter: Boolean(flags["reset"]),
  });
  console.log(JSON.stringify(redactFillReportForArtifact(report), null, 2));
  if (execute && report.verify && !report.verify.passed) {
    process.exitCode = 2;
  }
}

function cmdAtsFillOutcomes(
  flags: Record<string, string | boolean>,
): void {
  const doSummary =
    flags["summary"] === true ||
    flags["export"] === undefined ||
    flags["summary"] === "";
  const exportPath =
    typeof flags["export"] === "string" ? flags["export"] : undefined;

  if (!doSummary && !exportPath) {
    console.error(
      "Usage: ats:fill-outcomes [--summary] [--export <path.jsonl>]",
    );
    process.exit(1);
  }

  const db = openDatabase();
  try {
    migrate(db);
    if (doSummary) {
      console.log(JSON.stringify(summarizeFillOutcomes(db), null, 2));
    }
    if (exportPath) {
      const rows = exportFillOutcomesJsonl(db);
      const abs = path.resolve(exportPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
      fs.writeFileSync(abs, body, "utf8");
      console.error(
        JSON.stringify({ exported: rows.length, path: abs }, null, 2),
      );
    }
  } finally {
    closeDatabase(db);
  }
}

function cmdRecorderPromote(flags: Record<string, string | boolean>): void {
  const runId = flags["run"];
  const workflow = flags["workflow"];
  if (typeof runId !== "string" || typeof workflow !== "string") {
    console.error(
      "Usage: recorder:promote --run <runId> --workflow <name> [--force]",
    );
    process.exit(1);
  }
  parseWorkflow(workflow);

  const db = openDatabase();
  try {
    migrate(db);
    const result = promoteFixture({
      runId,
      workflow,
      force: Boolean(flags["force"]),
      db,
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.status === "failed") {
      process.exitCode = 2;
    }
  } finally {
    closeDatabase(db);
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
    case "recorder:promote":
      cmdRecorderPromote(flags);
      return;
    case "discover":
      await cmdDiscover(flags);
      return;
    case "enqueue":
      cmdEnqueue();
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
    case "ats:fill-outcomes":
      cmdAtsFillOutcomes(flags);
      return;
    case "resume:download":
      await cmdResumeDownload(flags);
      return;
    case "materials:register":
      cmdMaterialsRegister(flags);
      return;
    case "submit":
      await cmdSubmit(flags);
      return;
    case "review":
      cmdReview();
      return;
    case "review:resolve":
      cmdReviewResolve(flags);
      return;
    case "contacts:extract":
      await cmdContactsExtract(flags);
      return;
    case "email:generate":
      await cmdEmailGenerate(flags);
      return;
    case "draft:create": {
      const application = flags["application"];
      const contact = flags["contact"];
      if (typeof application !== "string" || typeof contact !== "string") {
        console.error(
          "Usage: draft:create --application <uuid> --contact <contact_id> [--headed]",
        );
        console.error(
          "Requires OUTLOOK_DRAFTS_ENABLED=true and DRY_RUN=false. Drafts only — nothing is ever dispatched.",
        );
        process.exit(2);
        return;
      }
      const db = openDatabase();
      try {
        migrate(db);
        const report = await createOutlookDraft({
          db,
          applicationId: application,
          contactId: contact,
          headless: flags["headed"] !== true,
        });
        console.log(JSON.stringify(report, null, 2));
        if (report.status !== "SAVED") process.exitCode = 1;
      } finally {
        closeDatabase(db);
      }
      return;
    }
    case "agent:author": {
      const url = flags["url"];
      if (typeof url !== "string") {
        console.error("Usage: agent:author --url <GREENHOUSE_APPLICATION_URL> [--cdp <url>]");
        console.error(
          "Phase 6 J1 authoring sidecar. Requires AGENT_AUTHORING_ENABLED=true, the agent/ venv, and a debug Chrome (npm run chrome:debug:jobright).",
        );
        process.exit(2);
        return;
      }
      const report = await runAgentAuthoring({
        url,
        ...(typeof flags["cdp"] === "string" ? { cdpUrl: flags["cdp"] } : {}),
      });
      console.log(JSON.stringify(report, null, 2));
      if (report.status !== "ok") process.exitCode = 1;
      return;
    }
    case "draft:verify": {
      const draft = flags["draft"];
      if (typeof draft !== "string") {
        console.error("Usage: draft:verify --draft <draft_id> [--headed]");
        process.exit(2);
        return;
      }
      const db = openDatabase();
      try {
        migrate(db);
        const report = await verifyOutlookDraft({
          db,
          draftId: draft,
          headless: flags["headed"] !== true,
        });
        console.log(JSON.stringify(report, null, 2));
        if (!report.verified) process.exitCode = 1;
      } finally {
        closeDatabase(db);
      }
      return;
    }
    case "run":
      if (flags["pipeline"]) {
        await cmdRunPipeline(flags);
        return;
      }
      // Historical behavior: bare `run` under DRY_RUN aliases discovery.
      if (flags["dry-run"] || getConfig().dryRun) {
        await cmdDiscover({ ...flags, fixture: flags["fixture"] ?? false });
        return;
      }
      console.error(
        "Use `run --pipeline [--app <uuid>] [--max N] [--submit]` to advance applications.",
      );
      process.exit(2);
      break;
    case "dashboard": {
      const db = openDatabase();
      migrate(db);
      const { url } = await startDashboard({ db });
      console.log(`Dashboard (read-only): ${url}`);
      console.log("Ctrl+C to stop.");
      // Keep the process alive; the server holds the event loop open.
      return;
    }
    case "retry": {
      const db = openDatabase();
      try {
        migrate(db);
        const results = retryFailedApplications(db);
        console.log(JSON.stringify({ retried: results }, null, 2));
      } finally {
        closeDatabase(db);
      }
      return;
    }
    case "resume-essay":
      cmdResumeEssay(flags);
      return;
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
