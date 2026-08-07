import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  migrate,
  openDatabase,
  type Db,
} from "../../src/storage/db/client.js";
import { createApplication } from "../../src/queue/stateMachine.js";
import { upsertJobByFingerprint } from "../../src/jobs/repository.js";
import { upsertOpenReviewItem } from "../../src/queue/reviewItems.js";
import {
  createDashboardHandler,
  startDashboard,
} from "../../src/dashboard/server.js";
import { buildReportSummary } from "../../src/dashboard/reportData.js";
import { resetConfigCache } from "../../src/config/index.js";
import type { IncomingMessage, ServerResponse } from "node:http";

type FakeResponse = {
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
};

function invoke(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  method: string,
  url: string,
): FakeResponse {
  const out: FakeResponse = { statusCode: 0, headers: {}, body: "" };
  const req = { method, url } as IncomingMessage;
  const res = {
    writeHead(status: number, headers?: Record<string, unknown>) {
      out.statusCode = status;
      if (headers) out.headers = headers;
      return this;
    },
    end(chunk?: string) {
      out.body = chunk ?? "";
    },
  } as unknown as ServerResponse;
  handler(req, res);
  return out;
}

describe("dashboard (UNIT_CONFIRMED)", () => {
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    resetConfigCache();
    dbPath = path.join(os.tmpdir(), `jaa-dash-${randomUUID()}.sqlite`);
    process.env.DATABASE_PATH = dbPath;
    db = openDatabase(dbPath);
    migrate(db);
    const job = upsertJobByFingerprint(db, {
      jobrightJobId: `jr-${randomUUID().slice(0, 8)}`,
      applicationUrl: `https://boards.greenhouse.io/acme/jobs/${Math.floor(Math.random() * 1e6)}`,
      company: "Acme",
      role: "SWE Intern",
    });
    const app = createApplication(db, { jobId: job.id });
    db.prepare(`UPDATE applications SET state = 'QUEUED' WHERE id = ?`).run(
      app.id,
    );
    upsertOpenReviewItem(db, {
      applicationId: app.id,
      kind: "MANUAL",
      title: "test item",
    });
  });

  afterEach(() => {
    closeDatabase(db);
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it("GET / serves HTML; API routes serve JSON with expected keys", () => {
    const handler = createDashboardHandler(db);

    const index = invoke(handler, "GET", "/");
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain("read-only dashboard");

    const summary = invoke(handler, "GET", "/api/summary");
    expect(summary.statusCode).toBe(200);
    const parsed = JSON.parse(summary.body) as Record<string, unknown>;
    for (const key of [
      "rollout_stage",
      "applications_by_state",
      "open_review_items",
      "auth",
      "submit_enabled",
    ]) {
      expect(parsed).toHaveProperty(key);
    }
    expect(parsed["open_review_items"]).toBe(1);

    const apps = invoke(handler, "GET", "/api/applications?state=QUEUED");
    expect(apps.statusCode).toBe(200);
    expect(JSON.parse(apps.body)).toHaveLength(1);

    const none = invoke(handler, "GET", "/api/applications?state=SUBMITTED");
    expect(JSON.parse(none.body)).toHaveLength(0);

    const items = invoke(handler, "GET", "/api/review-items");
    expect(JSON.parse(items.body)).toHaveLength(1);

    expect(invoke(handler, "GET", "/api/submissions").statusCode).toBe(200);
    expect(invoke(handler, "GET", "/api/drafts").statusCode).toBe(200);
  });

  it("refuses every non-GET method before routing", () => {
    const handler = createDashboardHandler(db);
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const r = invoke(handler, method, "/api/summary");
      expect(r.statusCode).toBe(405);
    }
  });

  it("unknown routes 404", () => {
    const handler = createDashboardHandler(db);
    expect(invoke(handler, "GET", "/api/secrets").statusCode).toBe(404);
    expect(invoke(handler, "GET", "/../etc/passwd").statusCode).toBe(404);
  });

  it("summary matches the shared report implementation", () => {
    const handler = createDashboardHandler(db);
    const viaHttp = JSON.parse(
      invoke(handler, "GET", "/api/summary").body,
    ) as Record<string, unknown>;
    const direct = buildReportSummary(db);
    expect(viaHttp["rollout_stage"]).toBe(direct["rollout_stage"]);
    expect(viaHttp["open_review_items"]).toBe(direct["open_review_items"]);
  });

  it("binds to 127.0.0.1 only", async () => {
    // Schema requires a positive port; pick a random high one for the test.
    process.env.DASHBOARD_PORT = String(20000 + Math.floor(Math.random() * 20000));
    resetConfigCache();
    try {
      const { server } = await startDashboard({ db });
      try {
        const addr = server.address() as AddressInfo;
        expect(addr.address).toBe("127.0.0.1");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      delete process.env.DASHBOARD_PORT;
      resetConfigCache();
    }
  });
});
