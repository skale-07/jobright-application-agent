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
  isCaptureWorthyQuestion,
  predictAnswersForQuestions,
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

  const writeProfile = (): void => {
    fs.writeFileSync(
      path.join(privDir, "candidate", "public-profile.json"),
      JSON.stringify({
        legal_name: { first: "Test", middle: "", last: "Candidate" },
        preferred_name: "",
        email: "test@example.com",
        phone: "",
        address: {
          line1: "",
          line2: "",
          city: "Baltimore",
          state: "Maryland",
          postal_code: "",
          country: "United States",
        },
        school: "Johns Hopkins University",
        degree: "Bachelor of Science",
        major: "Applied Mathematics & Statistics",
        additional_fields_of_study: [],
        graduation_month: "May",
        graduation_year: 2029,
        start_month: "August",
        start_year: 2025,
        gpa: null,
        linkedin_url: "",
        github_url: "",
        personal_website: "",
        work_authorization: "US Citizen",
        requires_sponsorship: "No",
        relocation: "",
        current_company: "",
        employment_history: [],
        education_history: [],
      }),
    );
  };

  it("capture works with the LLM flag OFF, opens an Answer-needed item, and dedupes", () => {
    // The LLM flag gates only the prediction batch — a blank field must
    // surface to the operator even in a shell with no LLM at all. This is
    // the live-run regression: SCREENER_PREDICT_LLM_ENABLED was off and
    // unanswered questions vanished silently.
    delete process.env.SCREENER_PREDICT_LLM_ENABLED;
    resetConfigCache();
    const appId = seedApp();
    const q = {
      label: "What is your expected graduation date?",
      type: "text" as const,
    };
    expect(
      recordUnmappedScreenerQuestions({ db, applicationId: appId, questions: [q] }),
    ).toBe(1);
    expect(recordUnmappedScreenerQuestions({ db, questions: [q] })).toBe(0); // dedupe

    const items = listOpenReviewItems(db);
    expect(items.length).toBe(1);
    expect(items[0]!.title).toMatch(/^Answer needed:/);
    expect(items[0]!.application_id).toBe(appId);
    const payload = JSON.parse(
      (items[0] as unknown as { payload_json: string }).payload_json,
    ) as Record<string, unknown>;
    expect(payload["source"]).toBe("screener_question");
    expect(payload["predicted_answer"]).toBeNull();
    expect(payload["suggested_key"]).toMatch(/^[a-z0-9_]{2,60}$/);
  });

  it("operator answers a captured question directly — no LLM involved", () => {
    delete process.env.SCREENER_PREDICT_LLM_ENABLED;
    resetConfigCache();
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
    const item = listOpenReviewItems(db)[0]!;
    // No answer supplied and none predicted: refused, item stays open.
    expect(() => promoteScreenerPrediction(db, { reviewItemId: item.id })).toThrow(
      /1-200 characters/,
    );
    // Off-option operator answer: refused.
    expect(() =>
      promoteScreenerPrediction(db, { reviewItemId: item.id, answer: "ML" }),
    ).toThrow(/must match one of the question's options/);
    // A real option: saved to the bank, item resolved, queue row PROMOTED.
    const res = promoteScreenerPrediction(db, {
      reviewItemId: item.id,
      answer: "Engineering",
    });
    expect(res.saved_answer).toBe("Engineering");
    expect(tryLoadScreenerBank()!.custom[res.bank_key]?.answer).toBe("Engineering");
    expect(listOpenReviewItems(db).length).toBe(0);
    const row = db
      .prepare(`SELECT status FROM screener_predictions LIMIT 1`)
      .get() as { status: string };
    expect(row.status).toBe("PROMOTED");
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
    // The capture item is enriched IN PLACE — no duplicate item.
    const items = listOpenReviewItems(db);
    expect(items.length).toBe(1);
    expect(items[0]!.title).toMatch(/^Answer needed:/);
    const payload = JSON.parse(
      (items[0] as unknown as { payload_json: string }).payload_json,
    ) as Record<string, unknown>;
    expect(payload["source"]).toBe("screener_prediction");
    expect(payload["predicted_answer"]).toBe("May 2029");
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
    // The capture item survives rejection — the operator can still answer
    // by hand; only the model gave up.
    expect(listOpenReviewItems(db).length).toBe(1);
    expect(listOpenReviewItems(db)[0]!.title).toMatch(/^Answer needed:/);
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
      i.title.startsWith("Answer needed:"),
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
      /screener question\/prediction items only/,
    );
  });

  // Live batch cc02e067 nulled 12/12 — including the university question
  // whose label SAID 'Select "Other" if not listed' — because the model
  // never saw the structured profile. profile_facts closes that gap; the
  // fallback answer still has to survive the option-membership gate.
  it("profile facts reach the model; a label-instructed \"Other\" fallback predicts", async () => {
    enable();
    writeProfile();
    const appId = seedApp();
    recordUnmappedScreenerQuestions({
      db,
      applicationId: appId,
      questions: [
        {
          label:
            'Which university are you currently attending? Select "Other" if not listed',
          type: "select",
          options: ["MIT", "Stanford University", "Other"],
        },
      ],
    });
    let sawUser = "";
    const recording = {
      generateJson: async (input: { user: string }) => {
        sawUser = input.user;
        return {
          text: JSON.stringify({
            predictions: [
              {
                label:
                  'Which university are you currently attending? Select "Other" if not listed',
                answer: "Other",
                key: "current_university",
                basis:
                  "profile_facts.school is Johns Hopkins University, not among options; label instructs Other",
              },
            ],
          }),
          model: "stub",
        };
      },
    };
    const r = await generateScreenerPredictions({ db, client: recording });
    expect(r.predicted).toBe(1);
    const ctx = JSON.parse(sawUser) as { profile_facts: Record<string, unknown> };
    expect(ctx.profile_facts["school"]).toBe("Johns Hopkins University");
    expect(ctx.profile_facts["city"]).toBe("Baltimore");
    // Contact details never ride the prediction context.
    expect(sawUser).not.toMatch(/test@example\.com/);
    const items = listOpenReviewItems(db);
    const item = items.find((i) => /university/i.test(i.title));
    expect(item).toBeTruthy();
    const payload = JSON.parse(
      (item as unknown as { payload_json: string }).payload_json,
    ) as Record<string, unknown>;
    expect(payload["predicted_answer"]).toBe("Other");
  });

  it("placeholder labels (field_12) reject immediately without spending the model", async () => {
    enable();
    const appId = seedApp();
    expect(
      recordUnmappedScreenerQuestions({
        db,
        applicationId: appId,
        questions: [{ label: "field_12", type: "select", options: ["A", "B"] }],
      }),
    ).toBe(0);
    // Legacy rows already in the queue (pre-filter) still reject without a model call.
    db.prepare(
      `INSERT INTO screener_predictions
         (id, label_fingerprint, label, raw_label, control, options_json, ats,
          first_seen_application_id, status, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, 'PENDING', 0, ?, ?)`,
    ).run(
      "legacy-field-12",
      "fp-field-12",
      "field 12",
      "field_12",
      "select",
      appId,
      new Date().toISOString(),
      new Date().toISOString(),
    );
    let called = 0;
    const r = await generateScreenerPredictions({
      db,
      client: {
        generateJson: async () => {
          called += 1;
          return { text: "{}", model: "stub" };
        },
      },
    });
    expect(called).toBe(0);
    expect(r.rejected).toBe(1);
    expect(r.notes.join(" ")).toMatch(/junk|unusable label/);
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

  it("does not treat major-option checkboxes, field_N, UUIDs, terms, or pronouns as questions", () => {
    expect(
      isCaptureWorthyQuestion({
        label: "Electrical Engineering",
        type: "checkbox",
      }),
    ).toBe(false);
    expect(isCaptureWorthyQuestion({ label: "field_114", type: "text" })).toBe(
      false,
    );
    expect(
      isCaptureWorthyQuestion({
        label: "59debaa2-5176-4710-939f-293b52c27284",
        type: "text",
      }),
    ).toBe(false);
    expect(
      isCaptureWorthyQuestion({
        label: "I agree to the Terms &amp; Conditions",
        type: "checkbox",
      }),
    ).toBe(false);
    expect(
      isCaptureWorthyQuestion({
        label: "Preferred pronouns",
        type: "select",
      }),
    ).toBe(false);
    expect(
      isCaptureWorthyQuestion({
        label: "Have you previously applied to this firm?",
        type: "radio",
      }),
    ).toBe(true);
    expect(
      recordUnmappedScreenerQuestions({
        db,
        questions: [
          { label: "Electrical Engineering", type: "checkbox" },
          { label: "field_12", type: "text" },
        ],
      }),
    ).toBe(0);
  });

  it("plan-time predict fills a page option and grounded free-text; skips invention", async () => {
    enable();
    const filled = await predictAnswersForQuestions(
      [
        {
          id: "wa",
          label: "Are you available to intern this summer?",
          options: ["Yes", "No"],
        },
        {
          id: "proj",
          label: "Describe a backend service you have built recently.",
        },
        {
          id: "hobby",
          label: "What is your favorite obscure hobby to mention?",
        },
      ],
      stub({
        predictions: [
          {
            label: "Are you available to intern this summer?",
            answer: "Yes",
            key: "available",
            basis: "profile",
          },
          {
            label: "Describe a backend service you have built recently.",
            answer: "anomaly-detection FastAPI service",
            key: "project",
            basis: "about-me",
          },
          {
            label: "What is your favorite obscure hobby to mention?",
            answer: "underwater basket weaving championships",
            key: "hobby",
            basis: "guess",
          },
        ],
      }),
    );
    expect(filled.get("wa")?.value).toBe("Yes");
    expect(filled.get("proj")?.value).toBe("anomaly-detection FastAPI service");
    expect(filled.has("hobby")).toBe(false);
  });
});

/**
 * Live 2026-08-14: "Are you legally authorized to work…" was the single
 * most common pre-click refusal (7 of 52 submit runs). The registry now
 * matches the label deterministically and the predictor derives Yes/No
 * from the operator's own profile facts — never from nothing.
 */
describe("work authorization + sponsorship screeners (UNIT_CONFIRMED)", () => {
  it("matches the live refusal labels to the new keys", async () => {
    const { matchScreenerKey } = await import(
      "../../src/candidate/screenerMatch.js"
    );
    expect(
      matchScreenerKey("Are you legally authorized to work in the United States?")?.key,
    ).toBe("work_authorization");
    expect(matchScreenerKey("Work Authorization")?.key).toBe("work_authorization");
    expect(
      matchScreenerKey(
        "Will you now or in the future require sponsorship for employment visa status?",
      )?.key,
    ).toBe("requires_sponsorship");
    expect(matchScreenerKey("Do you require visa sponsorship?")?.key).toBe(
      "requires_sponsorship",
    );
  });

  it("derives Yes/No from profile facts and never invents on empty", async () => {
    const { predictScreenerAnswer } = await import(
      "../../src/candidate/screenerPredict.js"
    );
    const base = { work_authorization: "", requires_sponsorship: "" };
    const p = (over: Record<string, unknown>) =>
      ({ ...base, ...over }) as never;

    expect(predictScreenerAnswer("work_authorization", p({ work_authorization: "US Citizen" }))?.value).toBe("Yes");
    expect(predictScreenerAnswer("work_authorization", p({ work_authorization: "yes" }))?.value).toBe("Yes");
    expect(predictScreenerAnswer("work_authorization", p({ work_authorization: "Green Card holder" }))?.value).toBe("Yes");
    expect(predictScreenerAnswer("work_authorization", p({ work_authorization: "No — need a visa" }))?.value).toBe("No");
    expect(predictScreenerAnswer("work_authorization", p({}))).toBeNull();

    expect(predictScreenerAnswer("requires_sponsorship", p({ requires_sponsorship: false }))?.value).toBe("No");
    expect(predictScreenerAnswer("requires_sponsorship", p({ requires_sponsorship: "no" }))?.value).toBe("No");
    expect(predictScreenerAnswer("requires_sponsorship", p({ requires_sponsorship: true }))?.value).toBe("Yes");
    expect(predictScreenerAnswer("requires_sponsorship", p({}))).toBeNull();
    // An ambiguous string never coerces.
    expect(predictScreenerAnswer("requires_sponsorship", p({ requires_sponsorship: "maybe" }))).toBeNull();
  });

  it("end to end: an empty bank + a profile fact fills the radio verbatim", async () => {
    const { resolveScreenerForField } = await import(
      "../../src/candidate/screenerMatch.js"
    );
    const resolution = resolveScreenerForField(
      {
        label: "Are you legally authorized to work in the United States?",
        type: "radio",
        options: ["Yes", "No"],
      },
      { version: 1, answers: {}, custom: {} },
      undefined,
      { work_authorization: "US Citizen" } as never,
    );
    expect(resolution).toMatchObject({ status: "fill", value: "Yes" });
  });
});
