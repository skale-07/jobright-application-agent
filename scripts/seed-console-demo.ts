/**
 * Seed a throwaway database with one application per interesting state so
 * the console can be exercised offline (every page, every review kind).
 * Fixture-only and mutation-free: no network, no browser, no flags.
 *
 *   DATABASE_PATH=/tmp/demo.sqlite npx tsx scripts/seed-console-demo.ts
 *
 * For an offline L3 (armed session) walkthrough, add a QUEUED backlog the
 * automation worker can chew through:
 *
 *   DATABASE_PATH=/tmp/demo.sqlite npx tsx scripts/seed-console-demo.ts --backlog 5
 *
 * Backlog apps carry a Greenhouse employer URL; register a default resume
 * (DEFAULT_RESUME_PATH) so materials auto-attach during the walk.
 */
import { randomUUID } from "node:crypto";
import { migrate, openDatabase } from "../src/storage/db/client.js";
import { createApplication } from "../src/queue/stateMachine.js";
import { upsertJobByFingerprint } from "../src/jobs/repository.js";
import { upsertOpenReviewItem, type ReviewKind } from "../src/queue/reviewItems.js";
import { openEssayReviewItem } from "../src/applications/essayAnswers.js";

const SEEDS: Array<{
  state: string;
  company: string;
  review?: ReviewKind;
  essay?: boolean;
}> = [
  { state: "QUEUED", company: "Acme" },
  { state: "READY_TO_SUBMIT", company: "Globex" },
  { state: "ESSAY_REQUIRED", company: "Initech", essay: true },
  { state: "AUTH_REQUIRED", company: "Umbrella", review: "AUTH_REQUIRED" },
  { state: "CAPTCHA_REQUIRED", company: "Soylent", review: "CAPTCHA_REQUIRED" },
  { state: "UNSUPPORTED_ATS", company: "Vehement", review: "UNSUPPORTED_ATS" },
  {
    state: "SUBMISSION_VERIFICATION_FAILED",
    company: "Cyberdyne",
    review: "UNCERTAIN_SUBMISSION",
  },
  { state: "AMBIGUOUS_FIELD", company: "Massive Dynamic", review: "AMBIGUOUS_FIELD" },
  { state: "COMPLETED", company: "Stark" },
];

function backlogCount(): number {
  const idx = process.argv.indexOf("--backlog");
  if (idx === -1) return 0;
  const n = Number(process.argv[idx + 1]);
  return Number.isFinite(n) && n > 0 ? Math.min(50, Math.round(n)) : 5;
}

function main(): void {
  const db = openDatabase();
  migrate(db);
  const created: Array<{ id: string; state: string; company: string }> = [];

  const seeds = [...SEEDS];
  for (let i = 0; i < backlogCount(); i++) {
    seeds.push({ state: "QUEUED", company: `Backlog Corp ${i + 1}` });
  }

  for (const seed of seeds) {
    const jobNo = Math.floor(Math.random() * 1_000_000);
    const job = upsertJobByFingerprint(db, {
      jobrightJobId: `jr-${randomUUID().slice(0, 8)}`,
      applicationUrl: `https://jobright.ai/jobs/info/${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      company: seed.company,
      role: "Software Engineer",
    });
    const app = createApplication(db, { jobId: job.id });
    db.prepare(`UPDATE applications SET state = ? WHERE id = ?`).run(seed.state, app.id);

    // Employer URL + a couple of timeline rows so the detail page has shape.
    const raw = JSON.parse(
      (db.prepare(`SELECT raw_json FROM jobs WHERE id = ?`).get(job.id) as {
        raw_json: string;
      }).raw_json,
    ) as Record<string, unknown>;
    raw["employer_application_url"] = `https://boards.greenhouse.io/acme/jobs/${jobNo}`;
    raw["employer_application_ats"] = "greenhouse";
    db.prepare(`UPDATE jobs SET raw_json = ? WHERE id = ?`).run(
      JSON.stringify(raw),
      job.id,
    );
    for (const [from, to] of [
      ["DISCOVERED", "QUEUED"],
      ["QUEUED", seed.state],
    ] as const) {
      db.prepare(
        `INSERT INTO application_events (
           id, application_id, previous_state, next_state, timestamp, reason,
           attempt, artifacts_json, warnings_json, run_id
         ) VALUES (?, ?, ?, ?, ?, ?, 0, '[]', '[]', NULL)`,
      ).run(randomUUID(), app.id, from, to, new Date().toISOString(), "seeded demo data");
    }

    if (seed.essay) {
      openEssayReviewItem(db, {
        applicationId: app.id,
        fields: [
          {
            id: "why",
            label: "Why do you want to work here?",
            type: "textarea",
            required: true,
          },
        ],
      });
    } else if (seed.review) {
      upsertOpenReviewItem(db, {
        applicationId: app.id,
        kind: seed.review,
        title: `${seed.review} demo item`,
        payload: { seeded: true },
      });
    }
    created.push({ id: app.id, state: seed.state, company: seed.company });
  }

  console.log(JSON.stringify({ seeded: created }, null, 2));
}

main();
