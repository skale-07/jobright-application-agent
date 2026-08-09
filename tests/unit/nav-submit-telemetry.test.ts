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
import {
  exportNavigationAttemptsJsonl,
  exportSubmitAttemptsJsonl,
  parseSubmitNotes,
  recordNavigationAttempt,
  recordSubmitAttempt,
} from "../../src/storage/navSubmitOutcomes.js";
import type { NavigationReport } from "../../src/navigation/runNavigation.js";
import { resetConfigCache } from "../../src/config/index.js";

/**
 * The 004 telemetry layer: navigation + submit attempts land as PII-safe,
 * indexed rows joinable to artifacts/logs on run_id + application_id, and
 * the aggregate views answer "what walls / what outcomes" directly.
 * UNIT_CONFIRMED.
 */
describe("navigation + submit attempt telemetry (UNIT_CONFIRMED)", () => {
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    resetConfigCache();
    dbPath = path.join(os.tmpdir(), `jaa-telemetry-${randomUUID()}.sqlite`);
    process.env.DATABASE_PATH = dbPath;
    db = openDatabase(dbPath);
    migrate(db);
  });

  afterEach(() => {
    closeDatabase(db);
    delete process.env.DATABASE_PATH;
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    resetConfigCache();
  });

  const navReport = (over: Partial<NavigationReport> = {}): NavigationReport => ({
    run_id: `nav-${randomUUID()}`,
    application_id: randomUUID(),
    jobright_job_id: "jr-1",
    method: null,
    resolved_url: null,
    resolved_ats: null,
    wall: "budget",
    phase_trace: [{ phase: "A_anchor_hrefs", outcome: "no external anchors" }],
    agent: null,
    gmail: null,
    need: null,
    session: "ephemeral",
    notes: ["unresolved by deterministic phases"],
    ...over,
  });

  it("records a navigation wall with hosts only — never the full URL", () => {
    const r = recordNavigationAttempt(
      {
        report: navReport(),
        startUrl: "https://jobright.ai/jobs/info/abc?token=SECRET",
        durationMs: 1234,
      },
      { db },
    );
    expect(r).not.toBeNull();
    const row = db
      .prepare(`SELECT * FROM navigation_attempts WHERE id = ?`)
      .get(r!.id) as Record<string, unknown>;
    expect(row["wall"]).toBe("budget");
    expect(row["resolved"]).toBe(0);
    expect(row["start_host"]).toBe("jobright.ai");
    expect(JSON.stringify(row)).not.toContain("SECRET");
  });

  it("records a resolved cdp-session attempt with agent stats", () => {
    const r = recordNavigationAttempt(
      {
        report: navReport({
          method: "agent",
          wall: "none",
          resolved_url: "https://jobs.ashbyhq.com/acme/123",
          resolved_ats: "ashby",
          session: "cdp",
          agent: { turns_used: 2, steps_used: 14, domains_visited: ["a.com"] },
        }),
        startUrl: "https://jobright.ai/x",
      },
      { db },
    );
    const row = db
      .prepare(`SELECT * FROM navigation_attempts WHERE id = ?`)
      .get(r!.id) as Record<string, unknown>;
    expect(row["resolved"]).toBe(1);
    expect(row["end_host"]).toBe("jobs.ashbyhq.com");
    expect(row["agent_turns"]).toBe(2);
    const rates = db
      .prepare(`SELECT * FROM navigation_wall_rates WHERE session_kind = 'cdp'`)
      .all();
    expect(rates.length).toBe(1);
  });

  it("records submit attempts and the outcome-rate view aggregates them", () => {
    const appId = randomUUID();
    recordSubmitAttempt(
      {
        runId: "run-1",
        applicationId: appId,
        ats: "ashby",
        outcome: "FAILED_BEFORE_CLICK",
        clicked: false,
        controlResolvedVia: null,
        ctaInventoryCount: 7,
        urlHost: "jobs.ashbyhq.com",
        reason: "submit control not found",
      },
      { db },
    );
    recordSubmitAttempt(
      {
        runId: "run-1",
        applicationId: appId,
        ats: "ashby",
        outcome: "SUBMITTED_VERIFIED",
        clicked: true,
        controlResolvedVia: "role-name",
        urlHost: "jobs.ashbyhq.com",
      },
      { db },
    );
    const rates = db
      .prepare(`SELECT * FROM submit_outcome_rates WHERE ats = 'ashby' ORDER BY outcome`)
      .all() as Array<Record<string, unknown>>;
    expect(rates.length).toBe(2);
    expect(rates[0]!["outcome"]).toBe("FAILED_BEFORE_CLICK");
    expect(rates[1]!["clicked_count"]).toBe(1);
  });

  it("export functions return rows oldest-first", () => {
    recordNavigationAttempt({ report: navReport() }, { db });
    recordSubmitAttempt(
      { runId: "r", applicationId: "a", ats: "lever", outcome: "REFUSED", clicked: false },
      { db },
    );
    expect(exportNavigationAttemptsJsonl(db).length).toBe(1);
    expect(exportSubmitAttemptsJsonl(db).length).toBe(1);
  });

  it("parseSubmitNotes extracts resolution tier and inventory count", () => {
    const parsed = parseSubmitNotes([
      'resolved via role-name: "Submit application"',
      "submit control clicked",
    ]);
    expect(parsed.via).toBe("role-name");
    expect(parsed.ctaInventoryCount).toBeNull();

    const miss = parseSubmitNotes([
      "submit control not found",
      'cta inventory: [{"tag":"button"},{"tag":"a"}]',
    ]);
    expect(miss.via).toBeNull();
    expect(miss.ctaInventoryCount).toBe(2);
  });

  it("fails open on a broken db — a run never dies on telemetry", () => {
    closeDatabase(db);
    const r = recordSubmitAttempt(
      { runId: "r", applicationId: "a", ats: "lever", outcome: "REFUSED", clicked: false },
      { db },
    );
    expect(r).toBeNull();
    db = openDatabase(dbPath); // reopen so afterEach can close cleanly
  });
});
