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
import { upsertJobByFingerprint } from "../../src/jobs/repository.js";
import { createApplication } from "../../src/queue/stateMachine.js";
import { resetConfigCache } from "../../src/config/index.js";
import {
  generateScreenerPredictions,
  recordUnmappedScreenerQuestions,
  suggestKey,
  validatePrediction,
} from "../../src/applications/screenerPredictionLlm.js";
import { promoteScreenerPrediction } from "../../src/queue/reviewResolvers.js";
import {
  listOpenReviewItems,
  upsertOpenReviewItem,
} from "../../src/queue/reviewItems.js";
import { tryLoadScreenerBank } from "../../src/candidate/screenersIO.js";
import { resolveCustomScreener } from "../../src/candidate/screenerMatch.js";
import { parseScreenerBank } from "../../src/candidate/screeners.js";
import { isScreenerFillCanonical } from "../../src/applications/approvedFillPlan.js";

/**
 * Predict-into-review with one-click promote. UNIT_CONFIRMED — the model
 * is a stub; every trust boundary is exercised: predictions never fill,
 * choice answers must match page options, only the promote resolver
 * writes the bank, and promoted entries resolve deterministically.
 */
describe("screener prediction + promote (UNIT_CONFIRMED)", () => {
  let dbPath: string;
  let db: Db;
  let privDir: string;
  const savedEnv: Record<string, string | undefined> = {};
  const KEYS = [
    "DATABASE_PATH",
    "PRIVATE_DIR",
    "ARTIFACTS_DIR",
    "SCREENER_PREDICT_LLM_ENABLED",
  ];

  beforeEach(() => {
    for (const k of KEYS) savedEnv[k] = process.env[k];
    resetConfigCache();
    dbPath = path.join(os.tmpdir(), `jaa-pred-${randomUUID()}.sqlite`);
    privDir = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-pred-priv-"));
    fs.mkdirSync(path.join(privDir, "candidate"), { recursive: true });
    process.env.DATABASE_PATH = dbPath;
    process.env.PRIVATE_DIR = privDir;
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
    fs.rmSync(privDir, { recursive: true, force: true });
    resetConfigCache();
  });

  const enable = (): void => {
    process.env.SCREENER_PREDICT_LLM_ENABLED = "true";
    resetConfigCache();
    fs.writeFileSync(
      path.join(privDir, "candidate", "about-me.md"),
      "# About me\nJohns Hopkins undergraduate, Applied Math & Statistics and Economics, class of 2029, based in Baltimore. Built an anomaly-detection FastAPI service and a PyTorch landmark model.",
    );
  };

  const seedApp = (): string => {
    const job = upsertJobByFingerprint(db, {
      jobrightJobId: `jr-${randomUUID().slice(0, 8)}`,
      applicationUrl: `https://jobs.ashbyhq.com/acme/${randomUUID()}`,
      company: "Acme",
      role: "Intern",
    });
    return createApplication(db, { jobId: job.id }).id;
  };

  const stub = (payload: unknown) => ({
    generateJson: async () => ({ text: JSON.stringify(payload), model: "stub" }),
  });

  it("capture is flag-gated and deduped by label", () => {
    delete process.env.SCREENER_PREDICT_LLM_ENABLED;
    resetConfigCache();
    expect(
      recordUnmappedScreenerQuestions({
        db,
        questions: [{ label: "What is your expected graduation date?", type: "text" }],
      }),
    ).toBe(0);

    enable();
    const q = { label: "What is your expected graduation date?", type: "text" };
    expect(recordUnmappedScreenerQuestions({ db, questions: [q] })).toBe(1);
    expect(recordUnmappedScreenerQuestions({ db, questions: [q] })).toBe(0); // dedupe
  });

  it("flag off degrades the batch to a named note", async () => {
    delete process.env.SCREENER_PREDICT_LLM_ENABLED;
    resetConfigCache();
    const r = await generateScreenerPredictions({ db, client: stub({}) });
    expect(r.predicted).toBe(0);
    expect(r.notes[0]).toMatch(/SCREENER_PREDICT_LLM_ENABLED off/);
  });

  it("predicts into a review item; nothing fills, row goes one-shot PREDICTED", async () => {
    enable();
    const appId = seedApp();
    recordUnmappedScreenerQuestions({
      db,
      applicationId: appId,
      questions: [
        {
          label: "What is your expected graduation date?",
          type: "text",
        },
      ],
    });
    const r = await generateScreenerPredictions({
      db,
      client: stub({
        predictions: [
          {
            label: "What is your expected graduation date?",
            answer: "May 2029",
            key: "expected_graduation",
            basis: "about-me says class of 2029",
          },
        ],
      }),
    });
    expect(r.predicted).toBe(1);
    const item = listOpenReviewItems(db).find(
      (i) => i.title.includes("New question learned"),
    );
    expect(item).toBeDefined();
    // The bank is untouched — predictions never write it.
    expect(tryLoadScreenerBank()).toBeNull();
    // Second batch: nothing pending, no re-open.
    const r2 = await generateScreenerPredictions({ db, client: stub({}) });
    expect(r2.questions_considered).toBe(0);
  });

  it("a choice prediction that matches no page option is rejected", async () => {
    enable();
    recordUnmappedScreenerQuestions({
      db,
      questions: [
        {
          label: "Which internship track interests you most?",
          type: "radio",
          options: ["Engineering", "Research", "Product"],
        },
      ],
    });
    // Burn both attempts with a non-option answer.
    for (let i = 0; i < 2; i++) {
      await generateScreenerPredictions({
        db,
        client: stub({
          predictions: [
            {
              label: "Which internship track interests you most?",
              answer: "Machine Learning", // not an option
              key: "internship_track",
              basis: "about-me mentions ML",
            },
          ],
        }),
      });
    }
    const row = db
      .prepare(`SELECT status FROM screener_predictions LIMIT 1`)
      .get() as { status: string };
    expect(row.status).toBe("REJECTED");
    expect(listOpenReviewItems(db).length).toBe(0);
  });

  it("promote writes the bank custom entry; future forms resolve deterministically", async () => {
    enable();
    const appId = seedApp();
    recordUnmappedScreenerQuestions({
      db,
      applicationId: appId,
      questions: [
        {
          label: "Which internship track interests you most?",
          type: "radio",
          options: ["Engineering", "Research", "Product"],
        },
      ],
    });
    await generateScreenerPredictions({
      db,
      client: stub({
        predictions: [
          {
            label: "Which internship track interests you most?",
            answer: "Engineering",
            key: "internship_track",
            basis: "builds ML systems per about-me",
          },
        ],
      }),
    });
    const item = listOpenReviewItems(db).find((i) =>
      i.title.includes("New question learned"),
    )!;

    const res = promoteScreenerPrediction(db, { reviewItemId: item.id });
    expect(res.bank_key).toBe("internship_track");
    expect(res.saved_answer).toBe("Engineering");

    // Bank now holds the custom entry, and the item is resolved.
    const bank = tryLoadScreenerBank()!;
    expect(bank.custom["internship_track"]?.answer).toBe("Engineering");
    expect(listOpenReviewItems(db).length).toBe(0);

    // The next form asking the same question resolves WITHOUT any model.
    const resolution = resolveCustomScreener(
      {
        label: "Which internship track interests you most?",
        type: "radio",
        options: ["Engineering", "Research", "Product"],
      },
      bank,
    );
    expect(resolution).toEqual({
      status: "fill",
      key: "custom:internship_track",
      value: "Engineering",
      basis: "exact_option",
    });
    // And its canonical is allowlisted for filling.
    expect(isScreenerFillCanonical("screener:custom:internship_track")).toBe(true);
    // A promoted answer that no longer matches a changed form's options parks.
    const parked = resolveCustomScreener(
      {
        label: "Which internship track interests you most?",
        type: "radio",
        options: ["Backend", "Frontend"],
      },
      bank,
    );
    expect(parked?.status).toBe("review");
  });

  it("promote rejects an operator edit that matches no option", async () => {
    enable();
    recordUnmappedScreenerQuestions({
      db,
      questions: [
        {
          label: "Preferred office day schedule?",
          type: "radio",
          options: ["3 days", "5 days"],
        },
      ],
    });
    await generateScreenerPredictions({
      db,
      client: stub({
        predictions: [
          {
            label: "Preferred office day schedule?",
            answer: "3 days",
            key: "office_days",
            basis: "hybrid preference",
          },
        ],
      }),
    });
    const item = listOpenReviewItems(db)[0]!;
    expect(() =>
      promoteScreenerPrediction(db, { reviewItemId: item.id, answer: "2 days" }),
    ).toThrow(/must match one of the question's options/);
    // Item stays open after the failed promote.
    expect(listOpenReviewItems(db).length).toBe(1);
  });

  it("promote refuses non-prediction MANUAL items", () => {
    const appId = seedApp();
    const { item } = upsertOpenReviewItem(db, {
      applicationId: appId,
      kind: "MANUAL",
      title: "Some other manual item",
      payload: {},
    });
    expect(() => promoteScreenerPrediction(db, { reviewItemId: item.id })).toThrow(
      /screener-prediction items only/,
    );
  });

  it("validatePrediction + suggestKey guardrails", () => {
    expect(validatePrediction("May 2029", null).ok).toBe(true);
    expect(validatePrediction("", null).ok).toBe(false);
    expect(validatePrediction("x".repeat(150), null).ok).toBe(false);
    expect(validatePrediction("[insert date]", null).ok).toBe(false);
    expect(validatePrediction("engineering", ["Engineering", "Product"]).value).toBe(
      "Engineering",
    );
    expect(validatePrediction("Design", ["Engineering", "Product"]).ok).toBe(false);
    expect(suggestKey("Expected Graduation!", "expected graduation date")).toBe(
      "expected_graduation",
    );
    expect(suggestKey(42, "what is your expected graduation date")).toBe(
      "what_your_expected_graduation_date",
    );
  });

  it("parseScreenerBank round-trips custom entries and rejects bad ones", () => {
    const bank = parseScreenerBank({
      version: 1,
      answers: { how_heard: "JobRight" },
      custom: {
        internship_track: {
          answer: "Engineering",
          labels: ["which internship track interests you most"],
          promoted_at: "2026-08-09T00:00:00Z",
        },
      },
    });
    expect(bank.custom["internship_track"]?.answer).toBe("Engineering");
    expect(() =>
      parseScreenerBank({
        version: 1,
        answers: {},
        custom: { "Bad Key!": { answer: "x", labels: ["y"] } },
      }),
    ).toThrow(/snake_case/);
    expect(() =>
      parseScreenerBank({
        version: 1,
        answers: {},
        custom: { how_heard: { answer: "x", labels: ["y"] } },
      }),
    ).toThrow(/collides with a registry key/);
  });
});
