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
import { createApplication } from "../../src/queue/stateMachine.js";
import { upsertJobByFingerprint } from "../../src/jobs/repository.js";
import {
  getHumanEssayAnswer,
  listHumanEssayAnswers,
  openEssayReviewItem,
  saveHumanEssayAnswer,
  unansweredEssayFieldKeys,
} from "../../src/applications/essayAnswers.js";
import {
  assertExecutableHumanEssayEntry,
  buildHumanEssayEntries,
  type HumanEssayEntry,
} from "../../src/applications/essayFill.js";
import { discoverFieldsFromHtml } from "../../src/applications/fieldDiscovery.js";
import { runAtsFixtureFill } from "../../src/applications/applicationFiller.js";
import { greenhouseFillFromPlan } from "../../src/ats/greenhouse/fill.js";
import type { ApprovedFillPlanEntry } from "../../src/applications/approvedFillPlan.js";
import { listOpenReviewItems } from "../../src/queue/reviewItems.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";
import { resetConfigCache } from "../../src/config/index.js";
import type { PublicProfile } from "../../src/candidate/publicProfile.js";

const essayFixtureHtml = fs.readFileSync(
  path.join(process.cwd(), "tests", "fixtures", "ats", "essay", "dom.sanitized.html"),
  "utf8",
);

const testProfile: PublicProfile = {
  legal_name: { first: "Test", last: "Candidate" },
  email: "candidate@example.com",
} as unknown as PublicProfile;

describe("essay answers storage (UNIT_CONFIRMED)", () => {
  let dbPath: string;
  let db: Db;
  let applicationId: string;

  beforeEach(() => {
    resetConfigCache();
    dbPath = path.join(os.tmpdir(), `jaa-essay-${randomUUID()}.sqlite`);
    process.env.DATABASE_PATH = dbPath;
    db = openDatabase(dbPath);
    migrate(db);
    const job = upsertJobByFingerprint(db, {
      jobrightJobId: `jr-${randomUUID().slice(0, 8)}`,
      applicationUrl: "https://boards.greenhouse.io/acme/jobs/1",
      company: "Acme",
      role: "Intern",
    });
    applicationId = createApplication(db, { jobId: job.id }).id;
  });

  afterEach(() => {
    closeDatabase(db);
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it("round-trips a human answer and upserts on rewrite", () => {
    saveHumanEssayAnswer(db, {
      applicationId,
      fieldKey: "why",
      text: "First draft.",
    });
    saveHumanEssayAnswer(db, {
      applicationId,
      fieldKey: "why",
      text: "Better draft.",
    });
    const answers = listHumanEssayAnswers(db, applicationId);
    expect(answers).toHaveLength(1);
    expect(answers[0]?.text).toBe("Better draft.");
    expect(answers[0]?.source).toBe("human");
  });

  it("refuses empty text", () => {
    expect(() =>
      saveHumanEssayAnswer(db, { applicationId, fieldKey: "why", text: "  " }),
    ).toThrow(/empty/i);
  });

  it("asks only for REQUIRED essays, and upserts once", () => {
    const fields = discoverFieldsFromHtml(essayFixtureHtml);
    const first = openEssayReviewItem(db, { applicationId, fields });
    const second = openEssayReviewItem(db, { applicationId, fields });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);

    // The fixture has a required essay ("why") and an optional one
    // ("extra"). Optional free-text is left blank by policy, so listing it
    // would hold the item — and the application — open forever.
    expect(first.essays.map((e) => e.field_id)).toEqual(["why"]);

    let remaining = unansweredEssayFieldKeys(db, applicationId, first.item);
    expect(remaining).toEqual(["why"]);

    saveHumanEssayAnswer(db, {
      applicationId,
      fieldKey: "why",
      text: "Because I love the mission.",
    });
    // Answering the required essay alone clears the item.
    remaining = unansweredEssayFieldKeys(db, applicationId, first.item);
    expect(remaining).toEqual([]);
  });
});

describe("human essay execution guard (UNIT_CONFIRMED)", () => {
  let dbPath: string;
  let db: Db;
  let applicationId: string;

  beforeEach(() => {
    resetConfigCache();
    dbPath = path.join(os.tmpdir(), `jaa-essayg-${randomUUID()}.sqlite`);
    process.env.DATABASE_PATH = dbPath;
    db = openDatabase(dbPath);
    migrate(db);
    const job = upsertJobByFingerprint(db, {
      jobrightJobId: `jr-${randomUUID().slice(0, 8)}`,
      applicationUrl: "https://boards.greenhouse.io/acme/jobs/1",
      company: "Acme",
      role: "Intern",
    });
    applicationId = createApplication(db, { jobId: job.id }).id;
  });

  afterEach(() => {
    closeDatabase(db);
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  function humanEntry(overrides: Partial<HumanEssayEntry> = {}): HumanEssayEntry {
    const { id } = saveHumanEssayAnswer(db, {
      applicationId,
      fieldKey: "why",
      text: "Because of the team.",
    });
    return {
      field_id: "why",
      label: "Why do you want to work at Acme?",
      type: "textarea",
      action: "ESSAY_HUMAN",
      value: "Because of the team.",
      answer_row_id: id,
      provenance: "human",
      ...overrides,
    };
  }

  it("accepts a genuine human entry", () => {
    expect(() =>
      assertExecutableHumanEssayEntry(db, humanEntry()),
    ).not.toThrow();
  });

  it("rejects non-human source rows re-read from the database", () => {
    const entry = humanEntry();
    db.prepare(`UPDATE application_answers SET source = 'profile' WHERE id = ?`).run(
      entry.answer_row_id,
    );
    expect(() => assertExecutableHumanEssayEntry(db, entry)).toThrow(
      /not human/,
    );
  });

  it("rejects tampered text, missing rows, demographics, and wrong action", () => {
    expect(() =>
      assertExecutableHumanEssayEntry(db, {
        ...humanEntry(),
        value: "swapped generated text",
      }),
    ).toThrow(/does not match stored answer/);
    expect(() =>
      assertExecutableHumanEssayEntry(db, {
        ...humanEntry(),
        answer_row_id: randomUUID(),
      }),
    ).toThrow(/answer row missing/);
    expect(() =>
      assertExecutableHumanEssayEntry(db, {
        ...humanEntry(),
        label: "Gender identity (optional)",
      }),
    ).toThrow(/demographics/);
    expect(() =>
      assertExecutableHumanEssayEntry(db, {
        ...humanEntry(),
        action: "FILL" as never,
      }),
    ).toThrow(/not a human essay entry/);
  });

  it("buildHumanEssayEntries only joins answered essay textareas", () => {
    const fields = discoverFieldsFromHtml(essayFixtureHtml);
    expect(buildHumanEssayEntries(db, applicationId, fields)).toEqual([]);
    saveHumanEssayAnswer(db, {
      applicationId,
      fieldKey: "why",
      text: "Mission fit.",
    });
    const entries = buildHumanEssayEntries(db, applicationId, fields);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.field_id).toBe("why");
    expect(entries[0]?.value).toBe("Mission fit.");
  });
});

describe("fixture essay fill (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("fixture_fill");

  let dbPath: string;
  let artifactsDir: string;
  let db: Db;
  let applicationId: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `jaa-essayf-${randomUUID()}.sqlite`);
    artifactsDir = path.join(os.tmpdir(), `jaa-essayf-art-${randomUUID()}`);
    process.env.DATABASE_PATH = dbPath;
    process.env.ARTIFACTS_DIR = artifactsDir;
    resetConfigCache();
    db = openDatabase(dbPath);
    migrate(db);
    const job = upsertJobByFingerprint(db, {
      jobrightJobId: `jr-${randomUUID().slice(0, 8)}`,
      applicationUrl: "https://boards.greenhouse.io/acme/jobs/1",
      company: "Acme",
      role: "Intern",
    });
    applicationId = createApplication(db, { jobId: job.id }).id;
  });

  afterEach(() => {
    closeDatabase(db);
    resetConfigCache();
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    fs.rmSync(artifactsDir, { recursive: true, force: true });
  });

  it("fills the essay textarea from a human answer; unanswered stays empty", async () => {
    saveHumanEssayAnswer(db, {
      applicationId,
      fieldKey: "why",
      text: "Because I have followed Acme's robotics work since high school.",
    });

    const report = await runAtsFixtureFill("essay", {
      execute: true,
      profile: testProfile,
      includeHumanEssays: { db, applicationId },
    });

    expect(report.mode).toBe("executed");
    expect(report.essay_fill?.filled).toEqual(["why"]);
    expect(report.essay_fill?.errors).toEqual([]);
    // The unanswered "extra" essay is not in the entries at all.
    expect(report.essay_fill?.filled).not.toContain("extra");
    // Approved plan still refuses every textarea.
    const textareaEntries = report.approved_plan?.entries.filter(
      (e) => e.type === "textarea",
    );
    expect(textareaEntries?.every((e) => !e.approved)).toBe(true);
  }, 30_000);

  it("without answers, essays stay skipped end-to-end", async () => {
    const report = await runAtsFixtureFill("essay", {
      execute: true,
      profile: testProfile,
      includeHumanEssays: { db, applicationId },
    });
    expect(report.essay_fill).toBeUndefined();
  }, 30_000);

  it("regression: greenhouseFillFromPlan still hard-rejects textarea entries", async () => {
    const bogus: ApprovedFillPlanEntry = {
      field_id: "why",
      label: "Why do you want to work at Acme?",
      type: "textarea",
      canonical_field: "email",
      action: "FILL",
      approved: true,
      value: "generated essay text",
      reason: "smuggled",
    };
    const { withFixtureHtmlPage } = await import(
      "../../src/browser/fixtureSession.js"
    );
    await withFixtureHtmlPage(essayFixtureHtml, async (page) => {
      const result = await greenhouseFillFromPlan(
        page,
        [bogus],
        new Map([["why", { type: "textarea" as const, inputId: "why" }]]),
      );
      expect(result.filled).toEqual([]);
      expect(result.errors.some((e) => /textarea|essay/i.test(e))).toBe(true);
    });
  }, 30_000);
});

describe("essay review CLI wiring (UNIT_CONFIRMED)", () => {
  it("ESSAY review kind resolves when all answers arrive", () => {
    const dbPath = path.join(os.tmpdir(), `jaa-essayr-${randomUUID()}.sqlite`);
    process.env.DATABASE_PATH = dbPath;
    resetConfigCache();
    const db = openDatabase(dbPath);
    try {
      migrate(db);
      const job = upsertJobByFingerprint(db, {
        jobrightJobId: `jr-${randomUUID().slice(0, 8)}`,
        applicationUrl: "https://boards.greenhouse.io/acme/jobs/1",
        company: "Acme",
        role: "Intern",
      });
      const app = createApplication(db, { jobId: job.id });
      const fields = discoverFieldsFromHtml(essayFixtureHtml);
      openEssayReviewItem(db, { applicationId: app.id, fields });
      expect(
        listOpenReviewItems(db).filter((i) => i.kind === "ESSAY"),
      ).toHaveLength(1);
    } finally {
      closeDatabase(db);
      for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
    }
  });
});
