#!/usr/bin/env node
import { migrate, openDatabase, closeDatabase } from "../storage/db/client.js";
import { getConfig, deriveRolloutStage } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { listOpenReviewItems } from "../queue/reviewItems.js";

function printHelp(): void {
  console.log(`jobright-application-agent (Phase 1)

Usage:
  npm run cli -- <command> [options]

Commands:
  --help                 Show help
  migrate                Apply SQLite migrations
  run [--dry-run]        Stub: start automation run (not implemented)
  dashboard              Stub: local dashboard (not implemented)
  inspect --job <id>     Stub: inspect job (not implemented)
  retry --application <id>
  resume-essay --application <id>
  report                 Print DB summary / open review items
  login --service <jobright|linkedin|outlook>
  record-jobright        Stub: Phase 2b recorder (not implemented)

Phase 1 implements migrate, report, and --help only.
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
    const apps = db.prepare(`SELECT state, COUNT(*) AS n FROM applications GROUP BY state`).all();
    const openReviews = listOpenReviewItems(db);
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
        },
        null,
        2,
      ),
    );
  } finally {
    closeDatabase(db);
  }
}

function main(): void {
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
    case "run":
      logger.info("run stub invoked", {
        action: "run_stub",
        metadata: { dry_run: Boolean(flags["dry-run"]) || getConfig().dryRun },
      });
      notImplemented("automation run (Phase 3+)");
      break;
    case "dashboard":
      notImplemented("dashboard (Phase 13)");
      break;
    case "inspect":
      notImplemented("inspect (Phase 3+)");
      break;
    case "retry":
      notImplemented("retry (Phase 7+)");
      break;
    case "resume-essay":
      notImplemented("resume-essay (Phase 8)");
      break;
    case "login":
      notImplemented(`login:${String(flags["service"] ?? "?")} (Phase 2)`);
      break;
    case "record-jobright":
      notImplemented("record:jobright (Phase 2b)");
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main();
