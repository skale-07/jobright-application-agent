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
import { upsertContact } from "../../src/contacts/repository.js";
import {
  composeDraftContent,
  hashDraftBody,
} from "../../src/outlook/draftComposer.js";
import { assertDraftCreationAllowed } from "../../src/outlook/draftRun.js";
import { resetConfigCache } from "../../src/config/index.js";

describe("draft creation gate (UNIT_CONFIRMED)", () => {
  const saved = {
    drafts: process.env.OUTLOOK_DRAFTS_ENABLED,
    dry: process.env.DRY_RUN,
  };

  afterEach(() => {
    if (saved.drafts === undefined) delete process.env.OUTLOOK_DRAFTS_ENABLED;
    else process.env.OUTLOOK_DRAFTS_ENABLED = saved.drafts;
    if (saved.dry === undefined) delete process.env.DRY_RUN;
    else process.env.DRY_RUN = saved.dry;
    resetConfigCache();
  });

  it("refuses with drafts flag off (regardless of DRY_RUN)", () => {
    process.env.OUTLOOK_DRAFTS_ENABLED = "false";
    process.env.DRY_RUN = "false";
    resetConfigCache();
    expect(() => assertDraftCreationAllowed()).toThrow(
      /OUTLOOK_DRAFTS_ENABLED/,
    );
  });

  it("refuses under DRY_RUN even with drafts enabled", () => {
    process.env.OUTLOOK_DRAFTS_ENABLED = "true";
    process.env.DRY_RUN = "true";
    resetConfigCache();
    expect(() => assertDraftCreationAllowed()).toThrow(/DRY_RUN=true/);
  });

  it("allows only the deliberate pair", () => {
    process.env.OUTLOOK_DRAFTS_ENABLED = "true";
    process.env.DRY_RUN = "false";
    resetConfigCache();
    expect(() => assertDraftCreationAllowed()).not.toThrow();
  });
});

describe("draft composition (UNIT_CONFIRMED)", () => {
  let dbPath: string;
  let db: Db;
  let applicationId: string;
  let contactId: string;

  function insertGeneration(input: {
    status: "VALIDATED" | "REJECTED";
    subject?: string | null;
    body?: string | null;
  }): void {
    db.prepare(
      `INSERT INTO email_generations (
        id, application_id, contact_id, prompt_version, model, subject,
        body_text, body_html, payload_json, validation_status, created_at
      ) VALUES (?, ?, ?, 'outreach-email.v1', 'stub', ?, ?, NULL, '{}', ?, ?)`,
    ).run(
      randomUUID(),
      applicationId,
      contactId,
      input.subject ?? "JHU undergrad interested in Acme / SWE Intern",
      input.body ?? "Hi Jordan,\n...\nBest,\nShubham Kale",
      input.status,
      new Date().toISOString(),
    );
  }

  beforeEach(() => {
    resetConfigCache();
    dbPath = path.join(os.tmpdir(), `jaa-draft-${randomUUID()}.sqlite`);
    process.env.DATABASE_PATH = dbPath;
    db = openDatabase(dbPath);
    migrate(db);
    const job = upsertJobByFingerprint(db, {
      jobrightJobId: `jr-${randomUUID().slice(0, 8)}`,
      applicationUrl: `https://boards.greenhouse.io/acme/jobs/${Math.floor(Math.random() * 1e6)}`,
      company: "Acme",
      role: "SWE Intern",
    });
    applicationId = createApplication(db, { jobId: job.id }).id;
    contactId = upsertContact(db, {
      applicationId,
      name: "Jordan Rivera",
      sourceCategory: "beyond",
      email: "jordan@example.com",
      jobrightContactId: "c-1",
    }).id;
  });

  afterEach(() => {
    closeDatabase(db);
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it("composes only from a VALIDATED generation", () => {
    insertGeneration({ status: "VALIDATED" });
    const composed = composeDraftContent(db, { applicationId, contactId });
    expect(composed.recipient_email).toBe("jordan@example.com");
    expect(composed.body_hash).toBe(hashDraftBody(composed.body_text));
  });

  it("refuses REJECTED, missing generation, and contact without email", () => {
    expect(() =>
      composeDraftContent(db, { applicationId, contactId }),
    ).toThrow(/No email generation/);

    insertGeneration({ status: "REJECTED" });
    expect(() =>
      composeDraftContent(db, { applicationId, contactId }),
    ).toThrow(/only VALIDATED/);

    const noEmail = upsertContact(db, {
      applicationId,
      name: "Sam Chen",
      sourceCategory: "beyond",
      jobrightContactId: "c-2",
    }).id;
    db.prepare(
      `INSERT INTO email_generations (
        id, application_id, contact_id, prompt_version, model, subject,
        body_text, body_html, payload_json, validation_status, created_at
      ) VALUES (?, ?, ?, 'outreach-email.v1', 'stub', 's', 'b', NULL, '{}', 'VALIDATED', ?)`,
    ).run(randomUUID(), applicationId, noEmail, new Date().toISOString());
    expect(() =>
      composeDraftContent(db, { applicationId, contactId: noEmail }),
    ).toThrow(/no email address/);
  });

  it("body hash is deterministic and whitespace-sensitive", () => {
    const h1 = hashDraftBody("Hello\nWorld");
    expect(hashDraftBody("Hello\nWorld")).toBe(h1);
    expect(hashDraftBody("Hello\nWorld ")).not.toBe(h1);
  });

  it("outlook_drafts unique index refuses a duplicate recipient per application", () => {
    const insert = () =>
      db
        .prepare(
          `INSERT INTO outlook_drafts (
            id, application_id, contact_id, recipient_email, subject, status,
            verified, created_at, metadata_json
          ) VALUES (?, ?, ?, 'jordan@example.com', 's', 'SAVED', 0, ?, '{}')`,
        )
        .run(randomUUID(), applicationId, contactId, new Date().toISOString());
    insert();
    expect(insert).toThrow(/UNIQUE/);
  });
});
