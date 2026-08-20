import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  closeDatabase,
  migrate,
  openDatabase,
  type Db,
} from "../../src/storage/db/client.js";
import { createApplication } from "../../src/queue/stateMachine.js";
import { upsertJobByFingerprint } from "../../src/jobs/repository.js";
import { upsertContact } from "../../src/contacts/repository.js";
import { createConsoleHandler } from "../../src/console/server.js";
import { getApplicationDetail } from "../../src/console/readModels.js";
import { generateBootToken } from "../../src/console/security.js";
import { resetConfigCache } from "../../src/config/index.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";

/**
 * X6 console-first outreach: the detail payload carries the Outreach card
 * data, the extension status route answers read-only, and the new run
 * kinds validate their inputs. UNIT_CONFIRMED — no browser, no network
 * (the CDP probe hits an unreachable loopback port and must degrade to
 * "unknown", which is itself the assertion).
 */
type FakeResponse = { statusCode: number; body: string };

async function invoke(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  method: string,
  url: string,
  options?: { token?: string; body?: string },
): Promise<FakeResponse> {
  const out: FakeResponse = { statusCode: 0, body: "" };
  const headers: Record<string, string> = { host: "127.0.0.1:8899" };
  if (options?.token) headers["authorization"] = `Bearer ${options.token}`;
  const req = Object.assign(
    (async function* () {
      if (options?.body) yield Buffer.from(options.body);
    })(),
    { method, url, headers },
  ) as unknown as IncomingMessage;
  const res = {
    headersSent: false,
    writeHead(status: number) {
      out.statusCode = status;
      (this as { headersSent: boolean }).headersSent = true;
      return this;
    },
    end(chunk?: string | Buffer) {
      out.body = chunk === undefined ? "" : chunk.toString();
    },
  } as unknown as ServerResponse;
  await handler(req, res);
  return out;
}

describe("console outreach + extension surface (UNIT_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  let tmpDir: string;
  let dbPath: string;
  let db: Db;
  let token: string;
  let applicationId: string;

  beforeEach(() => {
    resetConfigCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-x6-"));
    dbPath = path.join(tmpDir, "app.sqlite");
    process.env.DATABASE_PATH = dbPath;
    resetConfigCache();
    db = openDatabase(dbPath);
    migrate(db);
    const job = upsertJobByFingerprint(db, {
      jobrightJobId: `jr-${randomUUID().slice(0, 8)}`,
      applicationUrl: `https://boards.greenhouse.io/acme/jobs/${Math.floor(Math.random() * 1e6)}`,
      company: "Acme",
      role: "SWE Intern",
    });
    applicationId = createApplication(db, { jobId: job.id }).id;
    token = generateBootToken();
  });

  afterEach(() => {
    closeDatabase(db);
    delete process.env.DATABASE_PATH;
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function handler() {
    return createConsoleHandler({
      db,
      token,
      distDir: path.join(tmpDir, "dist"),
      artifactsDir: path.join(tmpDir, "artifacts"),
    });
  }

  it("application detail carries contacts, generated emails, and gmail drafts", () => {
    const contact = upsertContact(db, {
      applicationId,
      name: "Alex Yang",
      email: "ayang@jumptrading.com",
      sourceCategory: "email",
    });
    db.prepare(
      `INSERT INTO email_generations (
         id, application_id, contact_id, prompt_version, model, subject,
         body_text, body_html, payload_json, validation_status, created_at
       ) VALUES (?, ?, ?, 'outreach-email.v2', 'test-model', 'Subj',
                 'Hi Alex,\nbody', NULL, '{}', 'VALIDATED', ?)`,
    ).run(randomUUID(), applicationId, contact.id, new Date().toISOString());
    db.prepare(
      `INSERT INTO gmail_drafts (
         id, application_id, contact_id, recipient_email, subject, status,
         verified, metadata_json, created_at
       ) VALUES (?, ?, ?, 'ayang@jumptrading.com', 'Subj', 'DRAFTED', 1, '{}', ?)`,
    ).run(randomUUID(), applicationId, contact.id, new Date().toISOString());

    const detail = getApplicationDetail(db, applicationId)!;
    expect(detail.contacts).toHaveLength(1);
    expect(detail.contacts[0]).toMatchObject({
      name: "Alex Yang",
      email: "ayang@jumptrading.com",
    });
    expect(detail.email_generations[0]).toMatchObject({
      validation_status: "VALIDATED",
      subject: "Subj",
    });
    expect(detail.gmail_drafts[0]).toMatchObject({
      status: "DRAFTED",
      verified: 1,
    });
  });

  it("GET /api/extension/status degrades honestly when CDP is unreachable", async () => {
    process.env.AGENT_CDP_URL = "http://127.0.0.1:1";
    resetConfigCache();
    const res = await invoke(handler(), "GET", "/api/extension/status");
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body["verdict"]).toBe("unknown");
    expect(body["cdp_reachable"]).toBe(false);
    expect(body["ready"]).toBe(false);
    expect(body["trigger_selectors_promoted"]).toBe(0);
    delete process.env.AGENT_CDP_URL;
    resetConfigCache();
  });

  it("new outreach run kinds require application_id and honor flag minimums", async () => {
    const runManagerStub = {
      list: () => [],
      start: () => {
        throw new Error("should not start — validation must fail first");
      },
    };
    const h = createConsoleHandler({
      db,
      token,
      distDir: path.join(tmpDir, "dist"),
      artifactsDir: path.join(tmpDir, "artifacts"),
      runManager: runManagerStub as never,
    });
    const missingId = await invoke(h, "POST", "/api/runs", {
      token,
      body: JSON.stringify({ kind: "contacts", params: {} }),
    });
    expect(missingId.statusCode).toBe(400);
    expect(missingId.body).toMatch(/application_id/);

    // Flag not in ceiling/opt-ins (safe env) → friendly 403 naming it.
    const noFlag = await invoke(h, "POST", "/api/runs", {
      token,
      body: JSON.stringify({
        kind: "gmail_draft",
        params: { application_id: applicationId },
        flags: {},
      }),
    });
    expect(noFlag.statusCode).toBe(403);
    expect(noFlag.body).toMatch(/GMAIL_DRAFTS_ENABLED/);
  });
});
