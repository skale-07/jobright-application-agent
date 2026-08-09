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
import { upsertOpenReviewItem } from "../../src/queue/reviewItems.js";
import {
  generateEssayDrafts,
  validateDraft,
} from "../../src/applications/essayDraft.js";
import { resetConfigCache } from "../../src/config/index.js";

const GOOD_DRAFT =
  "I built a small distributed job scheduler in TypeScript for a systems " +
  "course, then rebuilt its queue layer twice after load tests exposed " +
  "ordering bugs. That project is why this role interests me: the posting " +
  "describes exactly the reliability work I want to keep doing. At Johns " +
  "Hopkins I have focused on backend coursework and shipped two projects " +
  "with real users, and I want to bring that same shipping discipline to " +
  "your team while learning from engineers who run systems at real scale.";

/**
 * Essay DRAFT assistant: suggestions only, from the operator's about-me
 * context, landing in the review item — never filled. UNIT_CONFIRMED;
 * the model is a stub.
 */
describe("essay draft assistant (UNIT_CONFIRMED)", () => {
  let dbPath: string;
  let db: Db;
  let privDir: string;
  let artDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ["DATABASE_PATH", "PRIVATE_DIR", "ARTIFACTS_DIR", "ESSAY_DRAFT_ENABLED"]) {
      savedEnv[k] = process.env[k];
    }
    resetConfigCache();
    dbPath = path.join(os.tmpdir(), `jaa-essay-${randomUUID()}.sqlite`);
    privDir = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-essay-priv-"));
    artDir = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-essay-art-"));
    fs.mkdirSync(path.join(privDir, "candidate"), { recursive: true });
    process.env.DATABASE_PATH = dbPath;
    process.env.PRIVATE_DIR = privDir;
    process.env.ARTIFACTS_DIR = artDir;
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
    fs.rmSync(artDir, { recursive: true, force: true });
    resetConfigCache();
  });

  const writeAboutMe = (): void => {
    fs.writeFileSync(
      path.join(privDir, "candidate", "about-me.md"),
      "# About me\nJohns Hopkins undergrad. Built a distributed job scheduler in TypeScript with a rebuilt queue layer after load-test ordering bugs. Backend coursework; two shipped projects with real users.",
    );
  };

  const seedAppWithEssayItem = (): { appId: string; itemId: string } => {
    const job = upsertJobByFingerprint(db, {
      jobrightJobId: `jr-${randomUUID().slice(0, 8)}`,
      applicationUrl: `https://jobs.ashbyhq.com/cohere/${Math.floor(Math.random() * 1e6)}`,
      company: "Cohere",
      role: "ML Intern",
    });
    const appId = createApplication(db, { jobId: job.id }).id;
    const { item } = upsertOpenReviewItem(db, {
      applicationId: appId,
      kind: "ESSAY",
      title: "Essay answers required",
      payload: {
        essays: [
          {
            field_id: "goodfit",
            label: "What makes you a good fit for Cohere?",
            is_essay: true,
          },
        ],
      },
    });
    return { appId, itemId: item.id };
  };

  const stub = (text: string) => ({
    generateJson: async () => ({ text, model: "stub" }),
  });

  it("refuses with the flag off", async () => {
    delete process.env.ESSAY_DRAFT_ENABLED;
    resetConfigCache();
    writeAboutMe();
    const { appId } = seedAppWithEssayItem();
    await expect(
      generateEssayDrafts({ db, applicationId: appId, client: stub("{}") }),
    ).rejects.toThrow(/ESSAY_DRAFT_ENABLED/);
  });

  it("refuses without about-me.md — no context, no drafts", async () => {
    process.env.ESSAY_DRAFT_ENABLED = "true";
    resetConfigCache();
    const { appId } = seedAppWithEssayItem();
    await expect(
      generateEssayDrafts({ db, applicationId: appId, client: stub("{}") }),
    ).rejects.toThrow(/about-me\.md/);
  });

  it("drafts land as artifact + review-item suggestion, marked UNVERIFIED — never filled", async () => {
    process.env.ESSAY_DRAFT_ENABLED = "true";
    resetConfigCache();
    writeAboutMe();
    const { appId, itemId } = seedAppWithEssayItem();

    const report = await generateEssayDrafts({
      db,
      applicationId: appId,
      client: stub(JSON.stringify({ draft: GOOD_DRAFT })),
    });
    expect(report.drafts.length).toBe(1);
    expect(report.drafts[0]!.status).toBe("drafted");
    const draftPath = report.drafts[0]!.draft_path!;
    expect(fs.readFileSync(draftPath, "utf8")).toMatch(/DRAFT \(UNVERIFIED\)/);

    const item = db
      .prepare(`SELECT payload_json, status FROM review_items WHERE id = ?`)
      .get(itemId) as { payload_json: string; status: string };
    const payload = JSON.parse(item.payload_json) as Record<string, unknown>;
    expect((payload["essay_drafts"] as Record<string, string>)["goodfit"]).toBe(GOOD_DRAFT);
    expect(payload["essay_drafts_validation_level"]).toBe("UNVERIFIED");
    // The item stays OPEN — the human still owns approval.
    expect(item.status).toBe("OPEN");
    // Nothing was written to the answers store — suggestions never fill.
    const answers = db
      .prepare(`SELECT COUNT(*) n FROM application_answers WHERE application_id = ?`)
      .get(appId) as { n: number };
    expect(answers.n).toBe(0);
  });

  it("validation rejects short, placeholder, and self-referencing drafts", () => {
    expect(validateDraft("too short").ok).toBe(false);
    expect(validateDraft(`${"word ".repeat(300)}`).ok).toBe(false);
    expect(validateDraft(`${"solid content ".repeat(30)}[insert project]`).ok).toBe(false);
    expect(validateDraft(`As an AI language model ${"filler ".repeat(50)}`).ok).toBe(false);
    expect(validateDraft(GOOD_DRAFT).ok).toBe(true);
  });

  it("a rejected model output records rejection and attaches nothing", async () => {
    process.env.ESSAY_DRAFT_ENABLED = "true";
    resetConfigCache();
    writeAboutMe();
    const { appId, itemId } = seedAppWithEssayItem();
    const report = await generateEssayDrafts({
      db,
      applicationId: appId,
      client: stub(JSON.stringify({ draft: "[insert enthusiasm here]" })),
    });
    expect(report.drafts[0]!.status).toBe("rejected");
    const payload = JSON.parse(
      (db.prepare(`SELECT payload_json FROM review_items WHERE id = ?`).get(itemId) as { payload_json: string }).payload_json,
    ) as Record<string, unknown>;
    expect(payload["essay_drafts"]).toBeUndefined();
  });
});
