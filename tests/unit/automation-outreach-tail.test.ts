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
import { createApplication, getApplication } from "../../src/queue/stateMachine.js";
import { upsertJobByFingerprint } from "../../src/jobs/repository.js";
import { upsertContact } from "../../src/contacts/repository.js";
import { listOpenReviewItems } from "../../src/queue/reviewItems.js";
import type { EmailLlmClient } from "../../src/contacts/emailLlm.js";
import type { GeneratedEmail } from "../../src/contacts/emailGenerate.js";
import { NON_ALUM_SUBJECT_PREFIX } from "../../src/contacts/emailGenerate.js";
import { personaSchema, type Persona } from "../../src/candidate/personas.js";
import { runOutreachTail } from "../../src/automation/worker.js";
import {
  applyControlledFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";
import { resetConfigCache } from "../../src/config/index.js";

/**
 * The post-submit outreach tail (M6): CONTACTS_EXTRACTED → generated email →
 * Outlook draft, drafts only, via injected seams. The real createOutlookDraft
 * is never touched here — the seams prove the control flow; the mailbox
 * mutation itself stays gated behind OUTLOOK_DRAFTS_ENABLED + DRY_RUN and
 * the sendGuards bans.
 */

const testPersona: Persona = personaSchema.parse({
  persona_id: "test",
  headline:
    "Rising sophomore at Johns Hopkins studying Applied Math & Statistics and Economics",
  education: {
    school: "Johns Hopkins University",
    class_year: 2029,
    majors: ["Applied Mathematics & Statistics", "Economics"],
  },
  projects: [
    {
      name: "Deterministic Application Pipeline",
      summary: "State-machine driven job application processor",
      tools: ["TypeScript", "SQLite", "Playwright"],
      relevance_tags: ["infra", "automation"],
    },
    {
      name: "Volatility Forecasting Model",
      summary: "GARCH-family model comparison on equity indices",
      tools: ["Python", "statsmodels"],
      relevance_tags: ["quant", "modeling"],
    },
  ],
});

function validOutput(): GeneratedEmail {
  return {
    subject: `${NON_ALUM_SUBJECT_PREFIX}Acme Robotics / SWE Intern`,
    used_alum_subject: false,
    persona_projects_used: [
      "Deterministic Application Pipeline",
      "Volatility Forecasting Model",
    ],
    body_text: [
      "Hi Jordan,",
      "",
      "Hope you're doing well. My name is Shubham Kale, and I'm a rising sophomore at Johns Hopkins studying Applied Math & Statistics and Economics. I'm interested in the SWE Intern role at Acme Robotics and saw your experience as a Software Engineer there, so I wanted to reach out.",
      "",
      "A few quick points:",
      "- I've built Deterministic Application Pipeline, using TypeScript and SQLite, which seems relevant to platform work.",
      "- I've also worked on Volatility Forecasting Model, focused on statistical evaluation.",
      "- What stood out to me about Acme Robotics is the robotics platform, especially the control-stack work.",
      "",
      "Would really appreciate 15 minutes sometime in the coming weeks to learn more about your work.",
      "",
      "Best,",
      "Shubham Kale",
    ].join("\n"),
  };
}

class StubClient implements EmailLlmClient {
  constructor(private readonly payload: unknown) {}
  async generateJson(): Promise<{ text: string; model: string }> {
    return {
      text:
        typeof this.payload === "string"
          ? this.payload
          : JSON.stringify(this.payload),
      model: "stub-model-1",
    };
  }
}

describe("L3 outreach tail (FIXTURE_CONFIRMED, drafts only)", () => {
  useIsolatedFillEnv("safe");
  let dbPath: string;
  let privateDir: string;
  let db: Db;
  let appId: string;
  let contactId: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `jaa-tail-${randomUUID()}.sqlite`);
    privateDir = path.join(os.tmpdir(), `jaa-tail-priv-${randomUUID()}`);
    const personasDir = path.join(privateDir, "candidate", "personas");
    fs.mkdirSync(personasDir, { recursive: true });
    fs.writeFileSync(
      path.join(personasDir, "default.json"),
      JSON.stringify(testPersona),
    );
    process.env.DATABASE_PATH = dbPath;
    process.env.PRIVATE_DIR = privateDir;
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key-000000000000";
    resetConfigCache();

    db = openDatabase(dbPath);
    migrate(db);
    const job = upsertJobByFingerprint(db, {
      jobrightJobId: `jr-${randomUUID().slice(0, 8)}`,
      applicationUrl: `https://boards.greenhouse.io/acme/jobs/${Math.floor(Math.random() * 1e6)}`,
      company: "Acme Robotics",
      role: "SWE Intern",
    });
    appId = createApplication(db, { jobId: job.id }).id;
    db.prepare(
      `UPDATE applications SET state = 'CONTACTS_EXTRACTED' WHERE id = ?`,
    ).run(appId);
    contactId = upsertContact(db, {
      applicationId: appId,
      name: "Jordan Rivera",
      title: "Software Engineer",
      company: "Acme Robotics",
      email: "jordan@example.com",
      sourceCategory: "beyond",
    }).id;
  });

  afterEach(() => {
    closeDatabase(db);
    delete process.env.DATABASE_PATH;
    delete process.env.PRIVATE_DIR;
    delete process.env.OPENAI_API_KEY;
    fs.rmSync(privateDir, { recursive: true, force: true });
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    resetConfigCache();
  });

  it("generates the email and reaches a verified draft through the seams — nothing sends", async () => {
    applyControlledFillEnv({
      EMAIL_GENERATION_ENABLED: "true",
      OUTLOOK_DRAFTS_ENABLED: "true",
      DRY_RUN: "false",
    });
    const draftCalls: Array<{ applicationId: string; contactId: string }> = [];
    const verifyCalls: string[] = [];

    const result = await runOutreachTail({
      db,
      applicationId: appId,
      emailClient: new StubClient(validOutput()),
      draftRunner: async (input) => {
        draftCalls.push({
          applicationId: input.applicationId,
          contactId: input.contactId,
        });
        return {
          draft_id: "draft-1",
          application_id: input.applicationId,
          contact_id: input.contactId,
          recipient_email: "jordan@example.com",
          subject: "s",
          status: "SAVED",
          verified: false,
          reason: "stub",
          application_state: "DRAFT_CREATED",
        };
      },
      draftVerifier: async (input) => {
        verifyCalls.push(input.draftId);
        return {
          draft_id: input.draftId,
          found: true,
          subject_matched: true,
          body_hash_matched: true,
          verified: true,
          notes: [],
        };
      },
    });

    expect(result.email_status).toBe("generated");
    expect(result.draft_status).toBe("verified");
    expect(draftCalls).toEqual([{ applicationId: appId, contactId }]);
    expect(verifyCalls).toEqual(["draft-1"]);
    // Generation advanced the state machine; no review item opened.
    expect(getApplication(db, appId)?.state).toBe("EMAIL_GENERATED");
    expect(listOpenReviewItems(db)).toHaveLength(0);
  });

  it("a rejected generation opens a review item and never reaches the draft seam", async () => {
    applyControlledFillEnv({
      EMAIL_GENERATION_ENABLED: "true",
      OUTLOOK_DRAFTS_ENABLED: "true",
      DRY_RUN: "false",
    });
    const bad = validOutput();
    bad.persona_projects_used = ["Invented Project"];
    let draftCalled = false;

    const result = await runOutreachTail({
      db,
      applicationId: appId,
      emailClient: new StubClient(bad),
      draftRunner: async () => {
        draftCalled = true;
        throw new Error("must not be called");
      },
    });

    expect(result.email_status).toBe("rejected");
    expect(result.draft_status).toBeNull();
    expect(draftCalled).toBe(false);
    // The submission-side state is untouched and the human has a review item.
    expect(getApplication(db, appId)?.state).toBe("EMAIL_GENERATING");
    expect(listOpenReviewItems(db).length).toBeGreaterThan(0);
  });

  it("with the gates off the tail skips without touching anything", async () => {
    // Safe env: EMAIL_GENERATION_ENABLED unset → fail-closed.
    let clientCalled = false;
    const result = await runOutreachTail({
      db,
      applicationId: appId,
      emailClient: {
        async generateJson() {
          clientCalled = true;
          return { text: "{}", model: "stub" };
        },
      },
    });
    expect(result.email_status).toBe("skipped");
    expect(clientCalled).toBe(false);
    expect(getApplication(db, appId)?.state).toBe("CONTACTS_EXTRACTED");
  });

  it("a draft failure opens a review item and never reverses the generation", async () => {
    applyControlledFillEnv({
      EMAIL_GENERATION_ENABLED: "true",
      OUTLOOK_DRAFTS_ENABLED: "true",
      DRY_RUN: "false",
    });
    const result = await runOutreachTail({
      db,
      applicationId: appId,
      emailClient: new StubClient(validOutput()),
      draftRunner: async () => {
        throw new Error("outlook exploded mid-compose");
      },
    });
    expect(result.email_status).toBe("generated");
    expect(result.notes.some((n) => /outreach tail error/.test(n))).toBe(true);
    expect(
      listOpenReviewItems(db).some((i) => /Outreach tail failed/.test(i.title)),
    ).toBe(true);
    // Email generation result stands.
    expect(getApplication(db, appId)?.state).toBe("EMAIL_GENERATED");
  });
});
