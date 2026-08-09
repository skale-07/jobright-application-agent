import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  migrate,
  openDatabase,
  type Db,
} from "../../src/storage/db/client.js";
import { recordSubmitAttempt } from "../../src/storage/navSubmitOutcomes.js";
import {
  evaluateAgentHostPolicy,
  HOST_POLICY_MIN_ATTEMPTS,
} from "../../src/navigation/hostPolicy.js";
import {
  collectSubmitMisses,
  proposeSubmitSelectorPatches,
} from "../../src/heal/submitInventoryHealer.js";
import { rankOutreachContacts, scoreContact } from "../../src/contacts/rank.js";
import { upsertJobByFingerprint } from "../../src/jobs/repository.js";
import { createApplication } from "../../src/queue/stateMachine.js";
import { resetConfigCache } from "../../src/config/index.js";

/**
 * The three agentic surfaces from docs/llm-agent-surfaces.md:
 *   (1) deterministic-first host policy learned from nav telemetry,
 *   (2) propose-only LLM healer over submit-miss CTA inventories,
 *   (3) deterministic contact ranking for the referral tail.
 * UNIT_CONFIRMED. No test calls a live model; the healer uses a stub.
 */
describe("agentic surfaces (UNIT_CONFIRMED)", () => {
  let dbPath: string;
  let db: Db;
  let artifactsDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ["DATABASE_PATH", "ARTIFACTS_DIR", "AGENT_AUTHORING_ENABLED"]) {
      savedEnv[k] = process.env[k];
    }
    resetConfigCache();
    dbPath = path.join(os.tmpdir(), `jaa-agentic-${randomUUID()}.sqlite`);
    artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-agentic-art-"));
    process.env.DATABASE_PATH = dbPath;
    process.env.ARTIFACTS_DIR = artifactsDir;
    db = openDatabase(dbPath);
    migrate(db);
  });

  afterEach(() => {
    closeDatabase(db);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    fs.rmSync(artifactsDir, { recursive: true, force: true });
    resetConfigCache();
  });

  const seedNavAttempt = (host: string, resolved: boolean, agentRan = true): void => {
    db.prepare(
      `INSERT INTO navigation_attempts
         (id, created_at, run_id, application_id, session_kind, wall,
          resolved, start_host, phase_trace_json, agent_turns)
       VALUES (?, ?, ?, ?, 'cdp', ?, ?, ?, '[]', ?)`,
    ).run(
      randomUUID(),
      new Date().toISOString(),
      `nav-${randomUUID()}`,
      randomUUID(),
      resolved ? "none" : "budget",
      resolved ? 1 : 0,
      host,
      agentRan ? 2 : null,
    );
  };

  it("host policy: unknown hosts and early failures still get the agent", () => {
    expect(evaluateAgentHostPolicy(db, "walls.example.com").runAgent).toBe(true);
    seedNavAttempt("walls.example.com", false);
    seedNavAttempt("walls.example.com", false);
    const p = evaluateAgentHostPolicy(db, "walls.example.com");
    expect(p.runAgent).toBe(true);
    expect(p.prior_agent_attempts).toBe(2);
  });

  it(`host policy: ${HOST_POLICY_MIN_ATTEMPTS} all-fail agent runs park the host; one success re-opens it`, () => {
    for (let i = 0; i < HOST_POLICY_MIN_ATTEMPTS; i++) {
      seedNavAttempt("hopeless.example.com", false);
    }
    const parked = evaluateAgentHostPolicy(db, "hopeless.example.com");
    expect(parked.runAgent).toBe(false);
    expect(parked.reason).toMatch(/deterministic-first/);

    seedNavAttempt("hopeless.example.com", true);
    expect(evaluateAgentHostPolicy(db, "hopeless.example.com").runAgent).toBe(true);
  });

  it("host policy: deterministic-only attempts (no agent) never count against a host", () => {
    for (let i = 0; i < 5; i++) seedNavAttempt("det.example.com", false, false);
    expect(evaluateAgentHostPolicy(db, "det.example.com").runAgent).toBe(true);
  });

  const INVENTORY =
    '[{"tag":"button","type":"button","text":"Submit application","visible":true},{"tag":"button","type":"button","text":"Next","visible":true}]';

  const seedMiss = (host: string): string => {
    // Review items FK onto applications — seed a real app row first.
    const job = upsertJobByFingerprint(db, {
      jobrightJobId: `jr-${randomUUID().slice(0, 8)}`,
      applicationUrl: `https://jobs.ashbyhq.com/acme/${Math.floor(Math.random() * 1e6)}`,
      company: "Acme",
      role: "SWE Intern",
    });
    const appId = createApplication(db, { jobId: job.id }).id;
    recordSubmitAttempt(
      {
        runId: "run-x",
        applicationId: appId,
        ats: "ashby",
        outcome: "FAILED_BEFORE_CLICK",
        clicked: false,
        urlHost: host,
        reason: `submit control not found; cta inventory: ${INVENTORY}`,
        ctaInventoryCount: 2,
      },
      { db },
    );
    return appId;
  };

  it("healer: refuses outright when AGENT_AUTHORING_ENABLED is off", async () => {
    delete process.env.AGENT_AUTHORING_ENABLED;
    resetConfigCache();
    await expect(
      proposeSubmitSelectorPatches({ db, client: { generateJson: async () => ({ text: "{}", model: "stub" }) } }),
    ).rejects.toThrow(/AGENT_AUTHORING_ENABLED/);
  });

  it("healer: collects one latest miss per (ats, host) with its inventory", () => {
    seedMiss("jobs.ashbyhq.com");
    seedMiss("jobs.ashbyhq.com");
    const misses = collectSubmitMisses(db);
    expect(misses.length).toBe(1);
    expect(misses[0]!.cta_inventory.length).toBe(2);
  });

  it("healer: proposals land as artifact + review items, never registry writes; wizard patterns are refused", async () => {
    process.env.AGENT_AUTHORING_ENABLED = "true";
    resetConfigCache();
    const appId = seedMiss("jobs.ashbyhq.com");
    const registryBefore = fs.readFileSync("src/ats/ashby/selectors.ts", "utf8");

    const report = await proposeSubmitSelectorPatches({
      db,
      client: {
        generateJson: async () => ({
          model: "stub",
          text: JSON.stringify({
            proposals: [
              {
                proposed_name_pattern: "submit\\s+application",
                proposed_css: null,
                rationale: "visible CTA named Submit application",
                confidence: "high",
              },
              {
                // Must be refused by the validation gate whatever the model says.
                proposed_name_pattern: "Next",
                proposed_css: null,
                rationale: "wizard",
                confidence: "high",
              },
            ],
          }),
        }),
      },
    });

    expect(report.misses_considered).toBe(1);
    expect(report.proposals.length).toBe(1);
    expect(report.proposals[0]!.validation_level).toBe("UNVERIFIED");
    expect(report.proposals_path).not.toBeNull();
    const written = JSON.parse(fs.readFileSync(report.proposals_path!, "utf8")) as {
      proposals: unknown[];
      apply_rule: string;
    };
    expect(written.proposals.length).toBe(1);
    expect(written.apply_rule).toMatch(/human-applied only/);
    expect(report.review_item_ids.length).toBe(1);
    const item = db
      .prepare(`SELECT application_id, status FROM review_items WHERE id = ?`)
      .get(report.review_item_ids[0]!) as { application_id: string; status: string };
    expect(item.application_id).toBe(appId);
    expect(item.status).toBe("OPEN");
    // The registries were never touched.
    expect(fs.readFileSync("src/ats/ashby/selectors.ts", "utf8")).toBe(registryBefore);
  });

  it("contact ranking: recruiters beat role-matched engineers beat unrelated titles; no-email never ranks", () => {
    const contacts = [
      { name: "A", email: "a@x.com", title: "Software Engineer, Platform", source_category: null },
      { name: "B", email: "b@x.com", title: "University Recruiter", source_category: null },
      { name: "C", email: null, title: "CEO", source_category: null },
      { name: "D", email: "d@x.com", title: "Accountant", source_category: null },
    ];
    const ranked = rankOutreachContacts(contacts, "Platform Engineering Intern");
    expect(ranked.map((c) => c.name)).toEqual(["B", "A", "D"]);
    expect(scoreContact(contacts[2]!, "x")).toBe(-1);
  });
});
