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
  labelFingerprint,
  mapScreenerLabels,
} from "../../src/applications/screenerLlmMap.js";
import { suggestBankAdditions } from "../../src/candidate/screenerSuggest.js";
import { resetConfigCache } from "../../src/config/index.js";

/**
 * LLM mapping assist (labels→keys only, cached, validated) and the
 * promote-if-verified suggestion loop. UNIT_CONFIRMED; the model is a stub.
 */
describe("screener LLM mapping + suggestions (UNIT_CONFIRMED)", () => {
  let dbPath: string;
  let db: Db;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ["DATABASE_PATH", "SCREENER_LLM_MATCH_ENABLED", "PRIVATE_DIR"]) {
      savedEnv[k] = process.env[k];
    }
    resetConfigCache();
    dbPath = path.join(os.tmpdir(), `jaa-scr-${randomUUID()}.sqlite`);
    process.env.DATABASE_PATH = dbPath;
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
    resetConfigCache();
  });

  it("flag off ⇒ no mappings, no model calls", async () => {
    delete process.env.SCREENER_LLM_MATCH_ENABLED;
    resetConfigCache();
    let calls = 0;
    const out = await mapScreenerLabels({
      labels: [{ label: "Do you require visa sponsorship down the road?" }],
      db,
      client: {
        generateJson: async () => {
          calls++;
          return { text: "{}", model: "stub" };
        },
      },
    });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  it("maps via the stub, refuses invented keys, and caches so the second call is free", async () => {
    process.env.SCREENER_LLM_MATCH_ENABLED = "true";
    resetConfigCache();
    let calls = 0;
    const client = {
      generateJson: async () => {
        calls++;
        return {
          model: "stub",
          text: JSON.stringify({
            mappings: [
              { label: "Can you commit to the full internship period?", key: "availability_full_time" },
              { label: "Favorite color?", key: "made_up_key" },
            ],
          }),
        };
      },
    };
    const labels = [
      { label: "Can you commit to the full internship period?" },
      { label: "Favorite color?" },
    ];
    const first = await mapScreenerLabels({ labels, db, client, ats: "ashby" });
    expect(first.find((m) => m.label.includes("commit"))?.key).toBe(
      "availability_full_time",
    );
    expect(first.find((m) => m.label.includes("color"))?.key).toBeNull();
    expect(calls).toBe(1);

    const second = await mapScreenerLabels({ labels, db, client, ats: "ashby" });
    expect(second.every((m) => m.source === "cache")).toBe(true);
    expect(calls).toBe(1); // cache hit — no second model call

    const row = db
      .prepare(`SELECT screener_key, source FROM screener_label_mappings WHERE label_fingerprint = ?`)
      .get(labelFingerprint("Favorite color?")) as { screener_key: string | null; source: string };
    expect(row.screener_key).toBeNull();
    expect(row.source).toBe("llm");
  });

  it("model failure fails open — empty result, run continues", async () => {
    process.env.SCREENER_LLM_MATCH_ENABLED = "true";
    resetConfigCache();
    const out = await mapScreenerLabels({
      labels: [{ label: "Some question" }],
      db,
      client: {
        generateJson: async () => {
          throw new Error("model down");
        },
      },
    });
    expect(out).toEqual([]);
  });

  it("suggestBankAdditions surfaces only VERIFIED screener fills missing from the bank", () => {
    // Point the bank at a temp private dir with no screeners.json.
    const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-priv-"));
    process.env.PRIVATE_DIR = privateDir;
    resetConfigCache();

    const runId = randomUUID();
    db.prepare(
      `INSERT INTO fill_runs (id, created_at, mode, source, job_url, mutation_attempted)
       VALUES (?, ?, 'executed', 'pipeline', 'https://jobs.ashbyhq.com/x', 1)`,
    ).run(runId, new Date().toISOString());
    const insertOutcome = db.prepare(
      `INSERT INTO fill_field_outcomes
         (id, fill_run_id, field_id, canonical_field, verify_match, selected_option)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    // Verified prediction → should be suggested.
    insertOutcome.run(randomUUID(), runId, "f1", "screener:education_level", 1, "Undergrad");
    // Unverified fill → never suggested.
    insertOutcome.run(randomUUID(), runId, "f2", "screener:closest_location", 0, "Canada");
    // Non-screener canonical → ignored.
    insertOutcome.run(randomUUID(), runId, "f3", "email", 1, null);

    const suggestions = suggestBankAdditions({ db });
    expect(suggestions).toEqual([
      {
        key: "education_level",
        suggested_answer: "Undergrad",
        verified_count: 1,
        last_seen: expect.any(String) as unknown as string,
      },
    ]);

    fs.rmSync(privateDir, { recursive: true, force: true });
  });
});
