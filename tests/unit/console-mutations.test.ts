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
import {
  listOpenReviewItems,
  upsertOpenReviewItem,
} from "../../src/queue/reviewItems.js";
import { openEssayReviewItem } from "../../src/applications/essayAnswers.js";
import { createConsoleHandler } from "../../src/console/server.js";
import { generateBootToken } from "../../src/console/security.js";
import { resetConfigCache } from "../../src/config/index.js";
import type { IncomingMessage, ServerResponse } from "node:http";

type FakeResponse = { statusCode: number; body: string };

const SYNTHETIC_PDF = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "ats",
  "greenhouse",
  "sample-resume.pdf",
);

describe("console mutation endpoints (UNIT_CONFIRMED)", () => {
  let tmpDir: string;
  let db: Db;
  let appId: string;
  const token = generateBootToken();

  function handler() {
    return createConsoleHandler({
      db,
      token,
      distDir: path.join(tmpDir, "dist"),
      artifactsDir: path.join(tmpDir, "artifacts"),
    });
  }

  async function post(
    url: string,
    body?: unknown,
    options?: { rawBody?: Buffer; headers?: Record<string, string> },
  ): Promise<FakeResponse> {
    const out: FakeResponse = { statusCode: 0, body: "" };
    const chunks: Buffer[] = [];
    if (options?.rawBody) chunks.push(options.rawBody);
    else if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body)));
    const req = Object.assign(
      (async function* () {
        for (const c of chunks) yield c;
      })(),
      {
        method: "POST",
        url,
        headers: {
          host: "127.0.0.1:8899",
          authorization: `Bearer ${token}`,
          "content-type": options?.rawBody ? "application/pdf" : "application/json",
          ...(options?.headers ?? {}),
        },
      },
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
    await handler()(req, res);
    return out;
  }

  function seedApp(state = "QUEUED"): string {
    const job = upsertJobByFingerprint(db, {
      jobrightJobId: `jr-${randomUUID().slice(0, 8)}`,
      applicationUrl: `https://boards.greenhouse.io/acme/jobs/${Math.floor(Math.random() * 1e6)}`,
      company: "Acme",
      role: "SWE",
    });
    const app = createApplication(db, { jobId: job.id });
    db.prepare(`UPDATE applications SET state = ? WHERE id = ?`).run(state, app.id);
    return app.id;
  }

  beforeEach(() => {
    resetConfigCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-console-mut-"));
    process.env.DATABASE_PATH = path.join(tmpDir, "app.sqlite");
    process.env.PRIVATE_DIR = path.join(tmpDir, "private");
    db = openDatabase(process.env.DATABASE_PATH);
    migrate(db);
    appId = seedApp();
  });

  afterEach(() => {
    closeDatabase(db);
    delete process.env.DATABASE_PATH;
    delete process.env.PRIVATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetConfigCache();
  });

  it("enqueue validates refs and the single-ref employer_url rule", async () => {
    expect((await post("/api/enqueue", { refs: [] })).statusCode).toBe(400);
    expect(
      (
        await post("/api/enqueue", {
          refs: ["https://jobright.ai/jobs/info/a", "https://jobright.ai/jobs/info/b"],
          employer_url: "https://boards.greenhouse.io/x/jobs/1",
        })
      ).statusCode,
    ).toBe(400);

    const ok = await post("/api/enqueue", {
      refs: [`https://jobright.ai/jobs/info/${randomUUID().replace(/-/g, "").slice(0, 24)}`],
    });
    expect(ok.statusCode).toBe(200);
    const report = JSON.parse(ok.body) as { enqueued: number };
    expect(report.enqueued).toBe(1);
  });

  it("retry endpoint returns the retried list", async () => {
    const res = await post("/api/retry");
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toHaveProperty("retried");
  });

  it("review resolve dispatches by kind and 400s on illegal actions", async () => {
    db.prepare(`UPDATE applications SET state = 'AUTH_REQUIRED' WHERE id = ?`).run(appId);
    const { item } = upsertOpenReviewItem(db, {
      applicationId: appId,
      kind: "AUTH_REQUIRED",
      title: "wall",
    });

    // Illegal action for the kind → 400 listing the legal ones.
    const bad = await post(`/api/review-items/${item.id}/resolve`, {
      action: "submitted",
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain("requeue");

    const ok = await post(`/api/review-items/${item.id}/resolve`, {
      action: "requeue",
      note: "logged in manually",
    });
    expect(ok.statusCode).toBe(200);
    expect(getApplication(db, appId)?.state).toBe("APPLICATION_OPENING");

    expect(
      (await post(`/api/review-items/${randomUUID()}/resolve`, { action: "dismiss" }))
        .statusCode,
    ).toBe(404);
  });

  it("essay answers resolve the ESSAY item and advance ESSAY_REQUIRED", async () => {
    db.prepare(`UPDATE applications SET state = 'ESSAY_REQUIRED' WHERE id = ?`).run(appId);
    openEssayReviewItem(db, {
      applicationId: appId,
      fields: [
        { id: "why", label: "Why Acme?", type: "textarea", required: true },
      ],
    });

    expect(
      (await post("/api/essays/answer", { application_id: appId, field_key: "why", text: " " }))
        .statusCode,
    ).toBe(400);

    const res = await post("/api/essays/answer", {
      application_id: appId,
      field_key: "why",
      text: "Because the mission fits.",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body["review_resolved"]).toBe(true);
    expect(body["application_state"]).toBe("FIELD_VERIFICATION");
    expect(listOpenReviewItems(db).filter((i) => i.kind === "ESSAY")).toHaveLength(0);
  });

  it("materials register by path and by upload land under the private inbox", async () => {
    const reg = await post("/api/materials/register", {
      application_id: appId,
      path: SYNTHETIC_PDF,
      label: "base",
    });
    expect(reg.statusCode).toBe(200);

    const pdf = fs.readFileSync(SYNTHETIC_PDF);
    const up = await post("/api/materials/upload", undefined, {
      rawBody: pdf,
      headers: { "x-application-id": appId, "x-filename": "My Résumé (v2).pdf" },
    });
    expect(up.statusCode).toBe(200);
    const body = JSON.parse(up.body) as { stored_path: string };
    expect(body.stored_path).toContain(path.join("private", "materials-inbox"));
    expect(fs.existsSync(body.stored_path)).toBe(true);
    // Sanitized filename — no spaces/parens survive.
    expect(path.basename(body.stored_path)).toMatch(/^[A-Za-z0-9._-]+$/);

    const notPdf = await post("/api/materials/upload", undefined, {
      rawBody: Buffer.from("plain text"),
      headers: { "x-application-id": appId, "x-filename": "x.pdf" },
    });
    expect(notPdf.statusCode).toBe(400);

    const missingHeader = await post("/api/materials/upload", undefined, {
      rawBody: pdf,
      headers: {},
    });
    expect(missingHeader.statusCode).toBe(400);
  });
});
