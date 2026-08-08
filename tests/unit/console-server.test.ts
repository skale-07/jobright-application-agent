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
import { createConsoleHandler, startConsole } from "../../src/console/server.js";
import { RunManager } from "../../src/console/runManager.js";
import {
  checkBearerToken,
  checkHostHeader,
  generateBootToken,
} from "../../src/console/security.js";
import { matchPattern } from "../../src/console/routes.js";
import { buildReportSummary } from "../../src/dashboard/reportData.js";
import { resetConfigCache } from "../../src/config/index.js";
import type { IncomingMessage, ServerResponse } from "node:http";

type FakeResponse = {
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
};

async function invoke(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  method: string,
  url: string,
  options?: { host?: string | null; token?: string; body?: string },
): Promise<FakeResponse> {
  const out: FakeResponse = { statusCode: 0, headers: {}, body: "" };
  const headers: Record<string, string> = {};
  if (options?.host !== null) headers["host"] = options?.host ?? "127.0.0.1:8899";
  if (options?.token) headers["authorization"] = `Bearer ${options.token}`;
  const req = Object.assign(
    // Async-iterable body so readJsonBody works against the fake.
    (async function* () {
      if (options?.body) yield Buffer.from(options.body);
    })(),
    { method, url, headers },
  ) as unknown as IncomingMessage;
  const res = {
    headersSent: false,
    writeHead(status: number, headers?: Record<string, unknown>) {
      out.statusCode = status;
      if (headers) out.headers = headers;
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

describe("console server (UNIT_CONFIRMED)", () => {
  let dbPath: string;
  let db: Db;
  let tmpDir: string;
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

  beforeEach(() => {
    resetConfigCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-console-"));
    dbPath = path.join(tmpDir, "app.sqlite");
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
    appId = app.id;
    db.prepare(`UPDATE applications SET state = 'QUEUED' WHERE id = ?`).run(appId);
    db.prepare(
      `INSERT INTO application_events (
         id, application_id, previous_state, next_state, timestamp, reason,
         attempt, artifacts_json, warnings_json, run_id
       ) VALUES (?, ?, 'DISCOVERED', 'QUEUED', ?, 'seeded', 0, ?, '[]', NULL)`,
    ).run(
      randomUUID(),
      appId,
      new Date().toISOString(),
      JSON.stringify(["applications/x/report.json"]),
    );
    db.prepare(
      `INSERT INTO materials (id, application_id, kind, path, sha256, size_bytes, verified, metadata_json, created_at)
       VALUES (?, ?, 'resume', '/tmp/r.pdf', 'abc', 123, 1, '{}', ?)`,
    ).run(randomUUID(), appId, new Date().toISOString());
    upsertOpenReviewItem(db, {
      applicationId: appId,
      kind: "MANUAL",
      title: "test item",
      payload: { hint: "x" },
    });
  });

  afterEach(() => {
    closeDatabase(db);
    delete process.env.DATABASE_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetConfigCache();
  });

  it("rejects missing or non-localhost Host headers on every route", async () => {
    const h = handler();
    expect((await invoke(h, "GET", "/api/summary", { host: null })).statusCode).toBe(403);
    expect(
      (await invoke(h, "GET", "/api/summary", { host: "evil.example" })).statusCode,
    ).toBe(403);
    expect(
      (await invoke(h, "POST", "/api/retry", { host: "evil.example", token })).statusCode,
    ).toBe(403);
    for (const host of ["127.0.0.1", "127.0.0.1:8899", "localhost:8899"]) {
      expect((await invoke(h, "GET", "/api/summary", { host })).statusCode).toBe(200);
    }
  });

  it("automation arm/disarm are bearer-gated; status is a tokenless read", async () => {
    const h = handler();
    // Status reads without a token.
    const s0 = await invoke(h, "GET", "/api/automation/status");
    expect(s0.statusCode).toBe(200);
    expect(JSON.parse(s0.body).armed).toBe(false);

    // Arm requires the token.
    expect((await invoke(h, "POST", "/api/automation/arm")).statusCode).toBe(401);

    const armed = await invoke(h, "POST", "/api/automation/arm", {
      token,
      body: JSON.stringify({ duration_minutes: 30, max_submits: 3, max_apps: 4 }),
    });
    expect(armed.statusCode).toBe(200);
    const armedBody = JSON.parse(armed.body);
    expect(armedBody.armed).toBe(true);
    expect(armedBody.max_submits).toBe(3);

    // Second arm while armed → 409.
    const again = await invoke(h, "POST", "/api/automation/arm", {
      token,
      body: JSON.stringify({}),
    });
    expect(again.statusCode).toBe(409);

    // Disarm, then status is clear.
    expect((await invoke(h, "POST", "/api/automation/disarm", { token })).statusCode).toBe(200);
    expect(JSON.parse((await invoke(h, "GET", "/api/automation/status")).body).armed).toBe(false);
  });

  it("automation run is refused (403) without AUTOMATION_ENABLED, and (409) when unarmed", async () => {
    // Needs the run routes, so build a handler WITH a RunManager. Both
    // refusals return before any child spawns.
    const h = createConsoleHandler({
      db,
      token,
      distDir: path.join(tmpDir, "dist"),
      artifactsDir: path.join(tmpDir, "artifacts"),
      runManager: new RunManager({ runsDir: path.join(tmpDir, "runs") }),
    });
    // Kill switch / capability not opted in → 403 before anything spawns.
    const denied = await invoke(h, "POST", "/api/runs", {
      token,
      body: JSON.stringify({ kind: "automation", params: {}, flags: {}, live_mode: false }),
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.body).toMatch(/AUTOMATION_ENABLED/);

    // With the flags satisfied by the ceiling + opt-in but no armed session,
    // the run is refused 409 (still before any spawn).
    const prior = {
      AUTOMATION_ENABLED: process.env.AUTOMATION_ENABLED,
      FORM_FILL_ENABLED: process.env.FORM_FILL_ENABLED,
      SUBMIT_ENABLED: process.env.SUBMIT_ENABLED,
      DRY_RUN: process.env.DRY_RUN,
    };
    process.env.AUTOMATION_ENABLED = "true";
    process.env.FORM_FILL_ENABLED = "true";
    process.env.SUBMIT_ENABLED = "true";
    process.env.DRY_RUN = "false";
    try {
      const unarmed = await invoke(h, "POST", "/api/runs", {
        token,
        body: JSON.stringify({
          kind: "automation",
          params: {},
          flags: {
            AUTOMATION_ENABLED: true,
            FORM_FILL_ENABLED: true,
            SUBMIT_ENABLED: true,
          },
          live_mode: true,
        }),
      });
      expect(unarmed.statusCode).toBe(409);
      expect(unarmed.body).toMatch(/no armed session/);
    } finally {
      for (const [k, v] of Object.entries(prior)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("kill switch beats arm: an ARMED session still cannot launch automation without AUTOMATION_ENABLED", async () => {
    const h = createConsoleHandler({
      db,
      token,
      distDir: path.join(tmpDir, "dist"),
      artifactsDir: path.join(tmpDir, "artifacts"),
      runManager: new RunManager({ runsDir: path.join(tmpDir, "runs") }),
    });
    // Arm a real session first.
    const armed = await invoke(h, "POST", "/api/automation/arm", {
      token,
      body: JSON.stringify({ duration_minutes: 30 }),
    });
    expect(JSON.parse(armed.body).armed).toBe(true);

    // Shell carries fill/submit/live but NOT the automation kill switch.
    const prior = {
      AUTOMATION_ENABLED: process.env.AUTOMATION_ENABLED,
      FORM_FILL_ENABLED: process.env.FORM_FILL_ENABLED,
      SUBMIT_ENABLED: process.env.SUBMIT_ENABLED,
      DRY_RUN: process.env.DRY_RUN,
    };
    delete process.env.AUTOMATION_ENABLED;
    process.env.FORM_FILL_ENABLED = "true";
    process.env.SUBMIT_ENABLED = "true";
    process.env.DRY_RUN = "false";
    try {
      const denied = await invoke(h, "POST", "/api/runs", {
        token,
        body: JSON.stringify({
          kind: "automation",
          params: {},
          flags: {
            AUTOMATION_ENABLED: true, // opted in, but not in the ceiling
            FORM_FILL_ENABLED: true,
            SUBMIT_ENABLED: true,
          },
          live_mode: true,
        }),
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.body).toMatch(/AUTOMATION_ENABLED/);
    } finally {
      for (const [k, v] of Object.entries(prior)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await invoke(h, "POST", "/api/automation/disarm", { token });
    }
  });

  it("automation exclude toggle round-trips through the API and the read models", async () => {
    const h = handler();

    // Bearer-gated; boolean-validated; 404 on unknown app.
    expect(
      (await invoke(h, "POST", `/api/applications/${appId}/automation`)).statusCode,
    ).toBe(401);
    expect(
      (
        await invoke(h, "POST", `/api/applications/${appId}/automation`, {
          token,
          body: JSON.stringify({ excluded: "yes" }),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await invoke(h, "POST", `/api/applications/${randomUUID()}/automation`, {
          token,
          body: JSON.stringify({ excluded: true }),
        })
      ).statusCode,
    ).toBe(404);

    // Exclude, preserving unrelated versions_json keys.
    db.prepare(`UPDATE applications SET versions_json = ? WHERE id = ?`).run(
      JSON.stringify({ resume_version: "v2" }),
      appId,
    );
    const excluded = await invoke(h, "POST", `/api/applications/${appId}/automation`, {
      token,
      body: JSON.stringify({ excluded: true }),
    });
    expect(excluded.statusCode).toBe(200);
    expect(JSON.parse(excluded.body)).toEqual({
      application_id: appId,
      automation_excluded: true,
    });
    const versions = JSON.parse(
      (
        db.prepare(`SELECT versions_json AS v FROM applications WHERE id = ?`).get(appId) as {
          v: string;
        }
      ).v,
    );
    expect(versions).toEqual({ resume_version: "v2", automation_excluded: true });

    // The list read model surfaces the flag + open-review presence.
    const list = JSON.parse((await invoke(h, "GET", "/api/applications")).body);
    const row = list.rows.find((r: { id: string }) => r.id === appId);
    expect(row.automation_excluded).toBe(true);
    expect(row.has_open_review).toBe(true); // seeded MANUAL item
    expect(row.versions_json).toBeUndefined();

    // Detail carries it too; include again flips it back.
    const detail = JSON.parse((await invoke(h, "GET", `/api/applications/${appId}`)).body);
    expect(detail.application.automation_excluded).toBe(true);
    await invoke(h, "POST", `/api/applications/${appId}/automation`, {
      token,
      body: JSON.stringify({ excluded: false }),
    });
    const after = JSON.parse((await invoke(h, "GET", "/api/applications")).body);
    expect(
      after.rows.find((r: { id: string }) => r.id === appId).automation_excluded,
    ).toBe(false);
  });

  it("refuses non-GET/POST methods and unauthorized POSTs", async () => {
    const h = handler();
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      expect((await invoke(h, method, "/api/summary")).statusCode).toBe(405);
    }
    const noToken = await invoke(h, "POST", "/api/anything");
    expect(noToken.statusCode).toBe(401);
    const badToken = await invoke(h, "POST", "/api/anything", { token: "wrong" });
    expect(badToken.statusCode).toBe(401);
    // Correct token but no such POST route → past auth, into routing.
    const authed = await invoke(h, "POST", "/api/anything", { token });
    expect(authed.statusCode).toBe(404);
  });

  it("serves summary (parity with buildReportSummary) and paged applications", async () => {
    const h = handler();
    const summary = JSON.parse((await invoke(h, "GET", "/api/summary")).body) as Record<
      string,
      unknown
    >;
    expect(summary["open_review_items"]).toBe(
      buildReportSummary(db)["open_review_items"],
    );

    const apps = JSON.parse(
      (await invoke(h, "GET", "/api/applications?state=QUEUED")).body,
    ) as { rows: unknown[]; total: number };
    expect(apps.total).toBe(1);
    expect(apps.rows).toHaveLength(1);

    const search = JSON.parse(
      (await invoke(h, "GET", "/api/applications?q=Acme")).body,
    ) as { total: number };
    expect(search.total).toBe(1);
    const miss = JSON.parse(
      (await invoke(h, "GET", "/api/applications?q=Nonexistent")).body,
    ) as { total: number };
    expect(miss.total).toBe(0);
  });

  it("application detail carries timeline, review items, materials, artifact links", async () => {
    const h = handler();
    const res = await invoke(h, "GET", `/api/applications/${appId}`);
    expect(res.statusCode).toBe(200);
    const detail = JSON.parse(res.body) as Record<string, unknown>;
    const timeline = detail["timeline"] as Array<Record<string, unknown>>;
    expect(timeline.length).toBeGreaterThanOrEqual(1);
    expect(timeline.some((t) => t["reason"] === "seeded")).toBe(true);
    expect((detail["review_items"] as unknown[]).length).toBe(1);
    expect((detail["materials"] as unknown[]).length).toBe(1);
    expect(detail["artifact_links"]).toContain("applications/x/report.json");
    const job = detail["job"] as Record<string, unknown>;
    expect(job["company"]).toBe("Acme");

    expect(
      (await invoke(h, "GET", `/api/applications/${randomUUID()}`)).statusCode,
    ).toBe(404);
  });

  it("review-items include parsed payloads and honor status/kind filters", async () => {
    const h = handler();
    const open = JSON.parse((await invoke(h, "GET", "/api/review-items")).body) as Array<
      Record<string, unknown>
    >;
    expect(open).toHaveLength(1);
    expect((open[0]!["payload"] as Record<string, unknown>)["hint"]).toBe("x");

    const manual = JSON.parse(
      (await invoke(h, "GET", "/api/review-items?kind=MANUAL")).body,
    ) as unknown[];
    expect(manual).toHaveLength(1);
    const essays = JSON.parse(
      (await invoke(h, "GET", "/api/review-items?kind=ESSAY")).body,
    ) as unknown[];
    expect(essays).toHaveLength(0);
    expect(
      (await invoke(h, "GET", "/api/review-items?kind=NOPE")).statusCode,
    ).toBe(500);
  });

  it("fill-outcomes returns summary plus success-rate rows", async () => {
    const h = handler();
    const res = await invoke(h, "GET", "/api/fill-outcomes");
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body).toHaveProperty("summary");
    expect(body).toHaveProperty("success_rates");
  });

  it("artifacts endpoint refuses traversal and disallowed extensions", async () => {
    const h = handler();
    const artDir = path.join(tmpDir, "artifacts");
    fs.mkdirSync(path.join(artDir, "navigation"), { recursive: true });
    fs.writeFileSync(path.join(artDir, "navigation", "report.json"), `{"ok":true}`);
    fs.writeFileSync(path.join(tmpDir, "outside.json"), `{"secret":true}`);
    fs.writeFileSync(path.join(artDir, "notes.sh"), "echo no");

    const ok = await invoke(h, "GET", "/api/artifacts?path=navigation/report.json");
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain(`"ok"`);

    expect(
      (await invoke(h, "GET", "/api/artifacts?path=../outside.json")).statusCode,
    ).toBe(403);
    expect(
      (await invoke(h, "GET", "/api/artifacts?path=..%2F..%2F.env")).statusCode,
    ).toBe(403);
    expect(
      (await invoke(h, "GET", "/api/artifacts?path=notes.sh")).statusCode,
    ).toBe(403);
    expect((await invoke(h, "GET", "/api/artifacts")).statusCode).toBe(400);
    expect(
      (await invoke(h, "GET", "/api/artifacts?path=navigation/missing.json")).statusCode,
    ).toBe(404);
  });

  it("serves a build-the-frontend placeholder without dist, SPA fallback with dist", async () => {
    const h = handler();
    const placeholder = await invoke(h, "GET", "/");
    expect(placeholder.statusCode).toBe(200);
    expect(placeholder.body).toContain("frontend:build");

    const dist = path.join(tmpDir, "dist");
    fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
    fs.writeFileSync(path.join(dist, "index.html"), "<html>console-spa</html>");
    fs.writeFileSync(path.join(dist, "assets", "app.js"), "// js");
    const index = await invoke(h, "GET", "/");
    expect(index.body).toContain("console-spa");
    const asset = await invoke(h, "GET", "/assets/app.js");
    expect(asset.headers["content-type"]).toContain("text/javascript");
    // Client-side route → SPA fallback; traversal → falls back safely too.
    expect((await invoke(h, "GET", "/applications/abc")).body).toContain("console-spa");
    expect((await invoke(h, "GET", "/../../etc/passwd")).body).toContain("console-spa");
  });

  it("security helpers: host parsing and constant-time token compare", () => {
    expect(
      checkHostHeader({ headers: { host: "localhost:5173" } } as never),
    ).toBe(true);
    expect(checkHostHeader({ headers: { host: "[::1]:8899" } } as never)).toBe(true);
    expect(checkHostHeader({ headers: { host: "evil.example" } } as never)).toBe(false);
    expect(checkHostHeader({ headers: {} } as never)).toBe(false);

    const t = generateBootToken();
    expect(t).toHaveLength(64);
    expect(
      checkBearerToken({ headers: { authorization: `Bearer ${t}` } } as never, t),
    ).toBe(true);
    expect(
      checkBearerToken({ headers: { authorization: `Bearer nope` } } as never, t),
    ).toBe(false);
    expect(checkBearerToken({ headers: {} } as never, t)).toBe(false);

    expect(matchPattern("/api/runs/:id/confirm", "/api/runs/r-1/confirm")).toEqual({
      id: "r-1",
    });
    expect(matchPattern("/api/runs/:id", "/api/runs")).toBeNull();
  });

  it("binds to 127.0.0.1 and returns a per-boot token", async () => {
    process.env.CONSOLE_PORT = String(20000 + Math.floor(Math.random() * 20000));
    resetConfigCache();
    try {
      const { server, token: bootToken } = await startConsole({
        db,
        distDir: path.join(tmpDir, "dist"),
      });
      try {
        const addr = server.address() as AddressInfo;
        expect(addr.address).toBe("127.0.0.1");
        expect(bootToken).toHaveLength(64);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      delete process.env.CONSOLE_PORT;
      resetConfigCache();
    }
  });
});
