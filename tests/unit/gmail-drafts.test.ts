import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import {
  createGmailDraft,
  draftEmailOnGmailPage,
} from "../../src/outreach/gmailDrafts.js";
import {
  closeDatabase,
  migrate,
  openDatabase,
  type Db,
} from "../../src/storage/db/client.js";
import { resetConfigCache } from "../../src/config/index.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";

/**
 * Gmail drafts tail (operator directive 2026-08-18). The mock compose page
 * records every draft save AND whether Send was ever clicked, so the two
 * invariants — drafts persist, nothing sends — are both assertions.
 */
const MOCK = fs.readFileSync(
  path.join(process.cwd(), "tests", "fixtures", "gmail", "compose-mock.html"),
  "utf8",
);

describe("gmail draft composition (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  it("composes, saves via Save & close, and NEVER clicks Send", async () => {
    await withFixtureHtmlPage(MOCK, async (page) => {
      const result = await draftEmailOnGmailPage(page, {
        to: "ayang@jumptrading.com",
        subject: "JHU sophomore interested in Jump Trading / Campus UI SWE",
        body: "Hi there,\n\nHope you're doing well...\n\nBest,\nShubham Kale\ngithub.com/skale-07",
      });
      expect(result.composed).toBe(true);

      const state = await page.evaluate<{
        sendClicked: boolean;
        drafts: Array<{ to: string; subject: string; body: string }>;
      }>(`({ sendClicked: window.__sendClicked, drafts: window.__drafts })`);
      expect(state.sendClicked).toBe(false);
      expect(state.drafts).toHaveLength(1);
      expect(state.drafts[0]).toMatchObject({
        to: "ayang@jumptrading.com",
        subject: "JHU sophomore interested in Jump Trading / Campus UI SWE",
      });
      expect(state.drafts[0]!.body).toContain("github.com/skale-07");
    });
  }, 60_000);

  it("reports honestly when no compose control exists", async () => {
    await withFixtureHtmlPage(
      "<html><body><p>not gmail</p></body></html>",
      async (page) => {
        const result = await draftEmailOnGmailPage(page, {
          to: "x@example.com",
          subject: "s",
          body: "b",
        });
        expect(result.composed).toBe(false);
        expect(result.notes.join(" ")).toMatch(/compose button not found/);
      },
    );
  }, 45_000);
});

describe("createGmailDraft gating (UNIT_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  let dbPath: string;
  let db: Db;
  beforeEach(() => {
    resetConfigCache();
    dbPath = path.join(os.tmpdir(), `jaa-gmaildraft-${randomUUID()}.sqlite`);
    db = openDatabase(dbPath);
    migrate(db);
  });
  afterEach(() => {
    closeDatabase(db);
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it("refuses without GMAIL_DRAFTS_ENABLED — fail closed, no browser opens", async () => {
    await expect(
      createGmailDraft({
        db,
        applicationId: randomUUID(),
        contactId: randomUUID(),
      }),
    ).rejects.toThrow(/GMAIL_DRAFTS_ENABLED=false/);
  });

  it("the migration created the gmail_drafts table with its idempotency key", () => {
    const cols = db
      .prepare(`PRAGMA table_info(gmail_drafts)`)
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        "id",
        "application_id",
        "contact_id",
        "recipient_email",
        "subject",
        "status",
        "verified",
      ]),
    );
    const idx = db
      .prepare(`SELECT sql FROM sqlite_master WHERE name = 'gmail_drafts'`)
      .get() as { sql: string };
    expect(idx.sql).toContain("UNIQUE(application_id, recipient_email)");
  });
});
