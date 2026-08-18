#!/usr/bin/env node
import { migrate, openDatabase, closeDatabase } from "../storage/db/client.js";
import {
  exportFillOutcomesJsonl,
  summarizeFillOutcomes,
} from "../storage/fillOutcomes.js";
import {
  exportNavigationAttemptsJsonl,
  exportSubmitAttemptsJsonl,
} from "../storage/navSubmitOutcomes.js";
import { proposeSubmitSelectorPatches } from "../heal/submitInventoryHealer.js";
import {
  forgetCustomScreenerAnswers,
  initScreenerBank,
  tryLoadScreenerBank,
} from "../candidate/screenersIO.js";
import { forgetScreenerPredictionRows } from "../applications/screenerPredictionLlm.js";
import { suggestBankAdditions } from "../candidate/screenerSuggest.js";
import {
  dismissReviewItem,
  requeueAfterWall,
} from "../queue/reviewResolvers.js";
import { generateEssayDrafts } from "../applications/essayDraft.js";
import { getConfig, deriveRolloutStage } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { listOpenReviewItems, resolveReviewItem } from "../queue/reviewItems.js";
import { getApplication, transitionApplication } from "../queue/stateMachine.js";
import {
  ESSAY_REVIEW_TITLE,
  recordEssayAnswer,
} from "../applications/essayAnswers.js";
import {
  ReviewResolverError,
  resolveUncertainSubmission,
} from "../queue/reviewResolvers.js";
import { runAtsSubmission } from "../applications/submitRun.js";
import { printOperatorFieldBrief } from "../applications/operatorFieldBrief.js";
import {
  resolveLiveFillResumePath,
  runAtsLiveFill,
} from "../applications/atsLiveFill.js";
import { ATS_BINDINGS } from "../applications/atsBindings.js";
import { detectAtsFromUrl } from "../ats/shared/urlValidationDispatch.js";
import { isLoopbackUrl } from "../ats/generic/urlValidation.js";
import { runNavigation } from "../navigation/runNavigation.js";
import { runGmailAuthFlow } from "../gmail/authFlow.js";
import { GmailClient } from "../gmail/client.js";
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
import { startConsole } from "../console/server.js";
import { runAgentAuthoring } from "../agent/authorRun.js";
import { buildReportSummary } from "../dashboard/reportData.js";
import { listContacts } from "../contacts/repository.js";
import { generateEmailForContact } from "../contacts/emailGenerate.js";
import { LLM_KEY_HINT, makeLlmClient } from "../contacts/emailLlm.js";
import { resolveNavVerificationWaiter } from "../verification/emailVerification.js";
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
  ats:fill --url <ATS_APPLICATION_URL (greenhouse|lever|ashby|localhost sandbox)> [--execute] [--submit] [--resume path] [--headed]
  ats:fill-outcomes [--summary] [--export <path.jsonl>]
  training:export [--out <dir>]         Dump fill/nav/submit attempt corpora as JSONL + manifest
  heal:submit-proposals [--limit N]     LLM selector-patch PROPOSALS from submit-miss inventories (AGENT_AUTHORING_ENABLED)
  screeners:init                        Create private/candidate/screeners.json from the example answer bank
  screeners:forget                      Wipe learned question/answer pairs so the next fill starts fresh
  screeners:suggest                     Verified screener predictions with no bank answer — ready-to-paste labels
  review:bulk --action dismiss|requeue-wall [--kind K] [--limit N] [--apply]   Triage open review items in bulk (dry-run by default)
  essay:draft --application <uuid>      LLM suggestion drafts for open essay questions (ESSAY_DRAFT_ENABLED; edit/approve in review)
  resume:download --job <jobright_job_id> [--yes] [--headless]
  materials:register --application <uuid> --file <path.pdf> [--label domain]
  resume-essay [--application <uuid> --field <field_id> --file <answer.txt>]
  submit --application <uuid> [--headed] [--yes]
  nav:resolve --app <uuid> [--headed]   Resolve employer URL from JobRight (NAVIGATION_ENABLED)
  gmail:auth --email <mailbox> --client-id <id> --client-secret <secret>   One-time readonly OAuth
  gmail:check                           Read-only Gmail token smoke test
  verify:mailbox [--since <minutes>] [--show] [--headed]   Smoke-test mailbox scan (gmail-web/outlook)
  auto:cycle [--no-update] [--headed] [--duration <min>] [--max-submits N] [--max-apps N]   One hands-off session cycle (operator-guide §19)
  viz:timeline [--limit N]              Render artifacts/console/run-timeline.html (read-only)
  review
  review:resolve --id <review_item_id> --outcome submitted|not-submitted [--requeue]
  run --pipeline [--app <uuid>] [--url <employer_url>] [--max N] [--submit] [--headed] [--fixture-html <path>]
  sandbox [--port N]   — local employer sandbox (gauntlet / portal / navhard / fillhard); drive with ats:fill --url http://localhost:4599/…
  retry [--app <uuid>]                  FAILED_RETRYABLE → QUEUED (all, or one; --app requeues even at cap 3)
  contacts:extract --application <uuid> [--fixture <html-path>] [--headed]
  email:generate --application <uuid> [--contact <id>] [--persona <id>]
  draft:create --application <uuid> --contact <contact_id> [--headed]
  draft:verify --draft <draft_id> [--headed]
  dashboard
  console                               Operator console (frontend + guarded mutation API)
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
      `Requires EMAIL_GENERATION_ENABLED=true and ${LLM_KEY_HINT} in .env.`,
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
    const client = makeLlmClient();
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

/** Navigation: resolve the employer application URL from the JobRight page. */
async function cmdNavResolve(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const app = flags["app"];
  if (typeof app !== "string") {
    console.error(
      "Usage: nav:resolve --app <application_uuid> [--headed]  (requires NAVIGATION_ENABLED=true)",
    );
    process.exit(1);
  }
  resetConfigCache();
  const db = openDatabase();
  try {
    migrate(db);
    const report = await runNavigation({
      db,
      applicationId: app,
      headless: flags["headed"] !== true,
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.resolved_url) process.exitCode = 2;
  } finally {
    closeDatabase(db);
  }
}

/** One-time Gmail readonly OAuth (verification codes/links for navigation). */
async function cmdGmailAuth(
  flags: Record<string, string | boolean>,
): Promise<void> {
  resetConfigCache();
  const clientId =
    (typeof flags["client-id"] === "string" ? flags["client-id"] : undefined) ??
    process.env.GMAIL_OAUTH_CLIENT_ID;
  const clientSecret =
    (typeof flags["client-secret"] === "string"
      ? flags["client-secret"]
      : undefined) ?? process.env.GMAIL_OAUTH_CLIENT_SECRET;
  const accountEmail =
    typeof flags["email"] === "string" ? flags["email"] : undefined;
  if (!clientId || !clientSecret || !accountEmail) {
    console.error(
      "Usage: gmail:auth --email <mailbox> --client-id <id> --client-secret <secret>",
    );
    console.error(
      "  (or set GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET in the shell — a Desktop-app OAuth client, scope gmail.readonly only)",
    );
    process.exit(1);
  }
  const tokenPath = await runGmailAuthFlow({
    clientId,
    clientSecret,
    accountEmail,
  });
  console.log(`Gmail readonly token stored: ${tokenPath}`);
}

/** Read-only Gmail smoke: refresh the token and count recent messages. */
async function cmdGmailCheck(): Promise<void> {
  resetConfigCache();
  const client = new GmailClient();
  const messages = await client.searchMessages("newer_than:1d", {
    maxResults: 5,
  });
  console.log(
    JSON.stringify(
      {
        account: client.accountEmail,
        recent_message_count: messages.length,
        scope: "gmail.readonly",
      },
      null,
      2,
    ),
  );
}

/**
 * Smoke test for the browser-based mailbox verification scan: run the
 * SAME provider chain a nav wall / submit recovery would use, against the
 * live inbox, and say which provider found what. The retrieved value is
 * masked by default (codes are transient secrets — never logged or
 * persisted); --show prints it to stdout only.
 */
async function cmdVerifyMailbox(
  flags: Record<string, string | boolean>,
): Promise<void> {
  resetConfigCache();
  const cfg = getConfig();
  if (!cfg.gmailVerificationEnabled && !cfg.outlookVerificationEnabled) {
    console.error(
      "No mailbox provider enabled — set GMAIL_VERIFICATION_ENABLED=true (browser scan, no token needed) and/or OUTLOOK_VERIFICATION_ENABLED=true.",
    );
    process.exit(2);
    return;
  }
  const sinceMinutes =
    typeof flags["since"] === "string" ? Number(flags["since"]) : 10;
  const requestedAt = new Date(
    Date.now() - Math.max(1, sinceMinutes) * 60_000,
  ).toISOString();
  const headed = flags["headed"] === true;
  console.log(
    `Scanning enabled mailboxes for a verification email newer than ${sinceMinutes}m (bounded ~1 min per provider${headed ? ", headed" : ""})...`,
  );
  // Production nav/submit keep headless; --headed is smoke-test only so you
  // can watch Outlook/Gmail storage-state browsers while debugging.
  const waiter = resolveNavVerificationWaiter({ headless: !headed });
  if (!waiter) {
    console.error("no provider resolved despite flags — check the shell env");
    process.exit(2);
    return;
  }
  const result = await waiter(
    { sent_to: "", requested_at: requestedAt },
    [],
  );
  if (result.kind === "timeout") {
    console.log(
      JSON.stringify(
        {
          outcome: "nothing_found",
          polls_used: result.pollsUsed,
          hint: "send yourself a test email with subject 'verification code' and body 'your code is 123456', then re-run",
        },
        null,
        2,
      ),
    );
    process.exit(1);
    return;
  }
  const value = result.kind === "code" ? result.code : result.url;
  const masked =
    value.length <= 4 ? "****" : `${value.slice(0, 4)}${"*".repeat(Math.min(value.length - 4, 12))}`;
  console.log(
    JSON.stringify(
      {
        outcome: "found",
        kind: result.kind,
        provider: result.messageId,
        polls_used: result.pollsUsed,
        value: flags["show"] === true ? value : masked,
        ...(flags["show"] === true ? {} : { note: "masked — pass --show to print in full" }),
      },
      null,
      2,
    ),
  );
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
    for (const i of items) {
      let payload: unknown = {};
      try {
        payload = JSON.parse(i.payload_json);
      } catch {
        payload = { raw: i.payload_json };
      }
      const brief =
        payload &&
        typeof payload === "object" &&
        payload !== null &&
        "operator_brief" in payload
          ? (payload as { operator_brief: unknown }).operator_brief
          : null;
      if (
        brief &&
        typeof brief === "object" &&
        brief !== null &&
        "items" in brief
      ) {
        printOperatorFieldBrief(
          brief as import("../applications/operatorFieldBrief.js").OperatorFieldBrief,
        );
      }
    }
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
    // Shared resolver (src/queue/reviewResolvers.ts) — the console uses the
    // same body, so CLI and UI resolution can never diverge.
    const resolved = resolveUncertainSubmission(db, {
      reviewItemId: id,
      outcome,
      requeue: flags["requeue"] === true,
      by: "review:resolve",
    });
    console.log(
      JSON.stringify(
        { resolved: id, outcome, state: resolved.application_state },
        null,
        2,
      ),
    );
  } catch (err) {
    if (err instanceof ReviewResolverError) {
      console.error(err.message);
      process.exit(1);
      return;
    }
    throw err;
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
    // Shared body (essayAnswers.recordEssayAnswer) — the console essays
    // endpoint uses the same function, so the workflows cannot diverge.
    const outcome = recordEssayAnswer(db, {
      applicationId: application,
      fieldKey: field,
      text,
      sourceFile: abs,
      resolvedBy: "resume-essay",
    });

    console.log(
      JSON.stringify(
        {
          answer_id: outcome.answerId,
          field_key: field,
          chars: text.trim().length,
          review_item_title: ESSAY_REVIEW_TITLE,
          review_resolved: outcome.reviewResolved,
          unanswered_fields: outcome.unansweredFields,
          application_state: outcome.applicationState,
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
      "   or: ats:fill --url <ATS_APPLICATION_URL> [--execute] [--submit] [--resume path] [--headed]",
    );
    process.exit(1);
  }

  // Allow --execute to force re-read of env if caller set vars in-shell
  resetConfigCache();

  const execute = Boolean(flags["execute"]);
  const wantSubmit = flags["submit"] === true;
  const explicitResume =
    typeof flags["resume"] === "string" ? flags["resume"] : undefined;
  const resolvedResume =
    typeof url === "string"
      ? resolveLiveFillResumePath({
          url,
          ...(explicitResume ? { explicitResumePath: explicitResume } : {}),
          defaultResumePath: getConfig().defaultResumePath,
        })
      : explicitResume
        ? { path: explicitResume, source: "flag" as const }
        : null;
  const resumePath = resolvedResume?.path;
  if (resolvedResume?.source === "sandbox_default") {
    console.error(
      `note: sandbox fill using DEFAULT_RESUME_PATH (${resolvedResume.path})`,
    );
  }
  const coverPath =
    typeof flags["cover"] === "string" ? flags["cover"] : undefined;

  if (wantSubmit && !execute) {
    console.error("ats:fill --submit requires --execute");
    process.exit(1);
  }
  if (wantSubmit && typeof url !== "string") {
    console.error(
      "ats:fill --submit is sandbox-only — pass --url http://localhost:4599/gauntlet",
    );
    process.exit(1);
  }
  if (wantSubmit && typeof url === "string" && !isLoopbackUrl(url)) {
    console.error(
      "ats:fill --submit is sandbox/loopback only. Use `submit --application <uuid>` for an employer.",
    );
    process.exit(1);
  }

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
      ...(wantSubmit ? { submit: true } : {}),
      ...(flags["yes"] === true ? { assumeYes: true } : {}),
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
    if (wantSubmit && liveReport.submit?.outcome === "uncertain") {
      process.exitCode = 3;
    } else if (
      wantSubmit &&
      liveReport.submit?.outcome &&
      liveReport.submit.outcome !== "confirmed"
    ) {
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

function cmdReviewBulk(flags: Record<string, string | boolean>): void {
  const action = flags["action"];
  if (action !== "dismiss" && action !== "requeue-wall") {
    console.error(
      "Usage: review:bulk --action dismiss|requeue-wall [--kind KIND] [--limit N] [--apply]\n" +
        "  dry-run by default: prints what WOULD happen; add --apply to execute.\n" +
        "  requeue-wall handles AUTH_REQUIRED/CAPTCHA_REQUIRED items (wall cleared by hand).",
    );
    process.exit(1);
  }
  const kindFilter = typeof flags["kind"] === "string" ? flags["kind"] : null;
  const limit = typeof flags["limit"] === "string" ? Number(flags["limit"]) || 50 : 50;
  const apply = flags["apply"] === true;

  const db = openDatabase();
  try {
    migrate(db);
    let items = listOpenReviewItems(db);
    if (kindFilter) items = items.filter((i) => i.kind === kindFilter);
    if (action === "requeue-wall") {
      items = items.filter(
        (i) => i.kind === "AUTH_REQUIRED" || i.kind === "CAPTCHA_REQUIRED",
      );
    }
    items = items.slice(0, limit);

    const results: Array<Record<string, unknown>> = [];
    let ok = 0;
    let failed = 0;
    for (const item of items) {
      if (!apply) {
        results.push({ id: item.id, kind: item.kind, application_id: item.application_id, would: action });
        continue;
      }
      try {
        const r =
          action === "dismiss"
            ? dismissReviewItem(db, { reviewItemId: item.id, note: "review:bulk" })
            : requeueAfterWall(db, { reviewItemId: item.id, note: "review:bulk" });
        ok++;
        results.push({ id: item.id, kind: item.kind, action: r.action, transition_skipped: r.transition_skipped ?? null });
      } catch (err) {
        failed++;
        results.push({ id: item.id, kind: item.kind, error: err instanceof Error ? err.message.slice(0, 120) : String(err) });
      }
    }
    console.log(
      JSON.stringify(
        {
          mode: apply ? "APPLIED" : "DRY_RUN (add --apply to execute)",
          action,
          kind_filter: kindFilter,
          matched: items.length,
          applied: ok,
          failed,
          items: results,
        },
        null,
        2,
      ),
    );
  } finally {
    closeDatabase(db);
  }
}

function cmdScreenersForget(): void {
  const custom = forgetCustomScreenerAnswers();
  const db = openDatabase();
  try {
    migrate(db);
    const predictions_cleared = forgetScreenerPredictionRows(db);
    console.log(
      JSON.stringify(
        {
          custom_cleared: custom.cleared,
          custom_keys: custom.keys,
          predictions_cleared,
          path: custom.path,
          note: "Registry answers (how_heard, etc.) were left alone. Custom learned pairs and the prediction queue are empty.",
        },
        null,
        2,
      ),
    );
  } finally {
    closeDatabase(db);
  }
}

function cmdScreenersInit(): void {
  const result = initScreenerBank();
  const bank = tryLoadScreenerBank();
  console.log(
    JSON.stringify(
      {
        ...result,
        note: result.created
          ? "Edit the answers to match YOU — they are typed verbatim into forms."
          : "screeners.json already exists — not overwritten",
        keys: bank ? Object.keys(bank.answers).length : 0,
      },
      null,
      2,
    ),
  );
}

async function cmdHealSubmitProposals(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const limit =
    typeof flags["limit"] === "string" ? Number(flags["limit"]) || 10 : 10;
  const db = openDatabase();
  try {
    migrate(db);
    const report = await proposeSubmitSelectorPatches({ db, limit });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    closeDatabase(db);
  }
}

function cmdTrainingExport(flags: Record<string, string | boolean>): void {
  const outDir = path.resolve(
    typeof flags["out"] === "string"
      ? flags["out"]
      : path.join("artifacts", "training", new Date().toISOString().replace(/[:.]/g, "-")),
  );
  const db = openDatabase();
  try {
    migrate(db);
    fs.mkdirSync(outDir, { recursive: true });
    const domains: Array<{ file: string; rows: Array<Record<string, unknown>> }> = [
      { file: "fill-outcomes.jsonl", rows: exportFillOutcomesJsonl(db) },
      { file: "navigation-attempts.jsonl", rows: exportNavigationAttemptsJsonl(db) },
      { file: "submit-attempts.jsonl", rows: exportSubmitAttemptsJsonl(db) },
    ];
    const manifest: Record<string, unknown> = {
      exported_at: new Date().toISOString(),
      pii_policy:
        "hosts, classes, fingerprints and short reasons only — raw field values, credentials and message bodies are never stored in these tables",
      domains: {} as Record<string, number>,
    };
    for (const d of domains) {
      const body =
        d.rows.map((r) => JSON.stringify(r)).join("\n") + (d.rows.length ? "\n" : "");
      fs.writeFileSync(path.join(outDir, d.file), body, "utf8");
      (manifest["domains"] as Record<string, number>)[d.file] = d.rows.length;
    }
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      "utf8",
    );
    console.log(JSON.stringify({ out_dir: outDir, ...manifest }, null, 2));
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
    case "screeners:init":
      cmdScreenersInit();
      break;
    case "screeners:forget":
      cmdScreenersForget();
      break;
    case "essay:draft": {
      const appId = flags["application"];
      if (typeof appId !== "string") {
        console.error("Usage: essay:draft --application <uuid>");
        process.exit(1);
      }
      const db = openDatabase();
      try {
        migrate(db);
        console.log(JSON.stringify(await generateEssayDrafts({ db, applicationId: appId }), null, 2));
      } finally {
        closeDatabase(db);
      }
      break;
    }
    case "review:bulk":
      cmdReviewBulk(flags);
      break;
    case "screeners:suggest":
      console.log(JSON.stringify({ suggestions: suggestBankAdditions() }, null, 2));
      break;
    case "heal:submit-proposals":
      await cmdHealSubmitProposals(flags);
      break;
    case "training:export":
      cmdTrainingExport(flags);
      break;
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
    case "nav:resolve":
      await cmdNavResolve(flags);
      return;
    case "gmail:auth":
      await cmdGmailAuth(flags);
      return;
    case "gmail:check":
      await cmdGmailCheck();
      return;
    case "verify:mailbox":
      await cmdVerifyMailbox(flags);
      return;
    case "accounts:set": {
      // Hand Dispatch an employer-portal login you already own. Stored in
      // the same 0600 vault file as a minted account (private/, gitignored);
      // never logged, never artifacted. Seeding a host is also the explicit
      // authorization for portal auth to sign in THERE.
      const host = (flags["host"] as string | undefined)?.trim().toLowerCase();
      const email = (flags["email"] as string | undefined)?.trim();
      const password = flags["password"] as string | undefined;
      if (!host || !email) {
        console.error(
          "usage: npm run cli -- accounts:set --host <hostname> --email <you@example.com> [--password <secret>]\n" +
            "  omit --password to keep/generate a strong one (you never need to know it)",
        );
        process.exit(2);
        return;
      }
      if (/(^|\.)jobright\.ai$/i.test(host)) {
        console.error("refusing: jobright.ai credentials belong to the login flow, not the vault");
        process.exit(2);
        return;
      }
      const { setAccount } = await import("../accounts/vault.js");
      const { replaced } = setAccount(host, {
        email,
        ...(password ? { password } : {}),
      });
      console.log(
        `${replaced ? "updated" : "stored"} credentials for ${host} (username ${email}, password ${password ? "set from --password" : "kept/generated"})`,
      );
      return;
    }
    case "accounts:list": {
      const { listAccountHosts } = await import("../accounts/vault.js");
      const hosts = listAccountHosts();
      console.log(
        hosts.length === 0
          ? "no portal accounts stored"
          : hosts.map((h) => `${h.host} (${h.username})`).join("\n"),
      );
      return;
    }
    case "auto:cycle": {
      const { runAutoCycle } = await import("../automation/autoCycle.js");
      const { autopushArtifacts } = await import(
        "../automation/artifactAutopush.js"
      );
      // Operator request (2026-08-12): a cycle you stop with Ctrl+C must
      // still ship its evidence. Push artifacts on the way out, then exit.
      // Idempotent + bounded; a second Ctrl+C exits immediately.
      let interrupting = false;
      const onInterrupt = (signal: NodeJS.Signals): void => {
        if (interrupting) process.exit(130);
        interrupting = true;
        console.error(
          `\n${signal} received — pushing artifacts before exit (Ctrl+C again to skip)...`,
        );
        void (async () => {
          try {
            if (getConfig().artifactAutopushEnabled) {
              const push = await autopushArtifacts({
                armRunId: "interrupted",
                message: `art: auto-cycle interrupted ${new Date().toISOString().replace(/[:.]/g, "-")} (autopush)`,
              });
              for (const n of push.notes) console.error(n);
            } else {
              console.error(
                "artifact autopush is off (ARTIFACT_AUTOPUSH_ENABLED) — nothing pushed",
              );
            }
          } catch (err) {
            console.error(
              `interrupt autopush failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          } finally {
            process.exit(130);
          }
        })();
      };
      process.on("SIGINT", onInterrupt);
      process.on("SIGTERM", onInterrupt);
      const num = (k: string): number | undefined =>
        typeof flags[k] === "string" && Number.isFinite(Number(flags[k]))
          ? Number(flags[k])
          : undefined;
      const report = await runAutoCycle({
        skipUpdate: flags["no-update"] === true,
        headless: flags["headed"] !== true,
        ...(num("duration") !== undefined ? { durationMinutes: num("duration")! } : {}),
        ...(num("max-submits") !== undefined ? { maxSubmits: num("max-submits")! } : {}),
        ...(num("max-apps") !== undefined ? { maxApps: num("max-apps")! } : {}),
      });
      console.log(JSON.stringify(report, null, 2));
      process.exit(report.outcome === "completed" || report.outcome === "skipped_already_armed" ? 0 : 1);
      return;
    }
    case "viz:timeline": {
      // Read-only render of what the last runs actually did. No DB, no
      // browser, no network, no flags — safe to run at any time.
      const { writeRunTimeline } = await import("../console/runTimeline.js");
      const limitFlag = flags["limit"];
      const limit =
        typeof limitFlag === "string" && Number.isFinite(Number(limitFlag))
          ? Number(limitFlag)
          : 40;
      const out = writeRunTimeline({ limit });
      console.log(out);
      return;
    }
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
    case "console": {
      const db = openDatabase();
      migrate(db);
      const { url, token } = await startConsole({ db });
      console.log(`Operator console: ${url}#token=${token}`);
      console.log(
        "Open the full URL above — the #token fragment authorizes mutations",
      );
      console.log("and never leaves the browser. Ctrl+C to stop.");
      // Keep the process alive; the server holds the event loop open.
      return;
    }
    case "sandbox": {
      const { runSandboxCommand } = await import("./sandboxCli.js");
      const portArg = flags["port"];
      await runSandboxCommand(
        typeof portArg === "string" ? ["--port", portArg] : [],
      );
      return;
    }
    case "retry": {
      const db = openDatabase();
      try {
        migrate(db);
        const appId =
          (typeof flags["app"] === "string" ? flags["app"] : undefined) ??
          (typeof flags["application"] === "string"
            ? flags["application"]
            : undefined);
        const results = retryFailedApplications(
          db,
          appId ? { applicationId: appId } : {},
        );
        if (appId && results.length === 0) {
          console.error(`No FAILED_RETRYABLE application ${appId}`);
          process.exit(1);
        }
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
