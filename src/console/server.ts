import http, {
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import { getConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import type { Db } from "../storage/db/client.js";
import {
  buildReportSummary,
  listDraftRows,
  listSubmissionRows,
} from "../dashboard/reportData.js";
import {
  buildFillOutcomesView,
  getApplicationDetail,
  listApplicationRowsPaged,
  listReviewItemViews,
} from "./readModels.js";
import { checkBearerToken, checkHostHeader, generateBootToken } from "./security.js";
import { buildMutationRoutes } from "./mutations.js";
import { buildAutomationRoutes } from "./automationRoutes.js";
import { getArmStatus, sweepStaleArmSessions } from "../automation/armSession.js";
import { buildRunRoutes } from "./runRoutes.js";
import { buildGmailRoutes } from "./gmailRoutes.js";
import { GmailAuthBroker } from "./gmailAuthBroker.js";
import { RunManager } from "./runManager.js";
import { findRoute, type Route } from "./routes.js";
import { serveStatic } from "./staticFiles.js";
import { BodyError } from "./body.js";

/**
 * Operator console server. Unlike the dashboard (GET-only by construction),
 * the console exposes guarded mutation routes — every one requires the
 * per-boot bearer token, and every request (GET included) passes a
 * Host-header check so a DNS-rebound page can never reach the API.
 * Capability still comes only from the operator's shell: the server itself
 * starts with no flags and read endpoints work regardless.
 */

const ARTIFACT_EXTENSIONS = new Set([".json", ".png", ".jpg", ".jpeg", ".txt", ".html", ".md"]);

export type ConsoleDeps = {
  db: Db;
  token: string;
  distDir: string;
  artifactsDir: string;
  runManager?: RunManager;
  gmailBroker?: GmailAuthBroker;
  /** Escape hatch for tests that need a route the console does not ship. */
  extraRoutes?: Route[];
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body, null, 2));
}

export function createConsoleHandler(
  deps: ConsoleDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const routes: Route[] = [
    {
      method: "GET",
      pattern: "/api/summary",
      handler: ({ res }) => json(res, 200, buildReportSummary(deps.db)),
    },
    {
      method: "GET",
      pattern: "/api/applications",
      handler: ({ res, searchParams }) => {
        const limit = Number(searchParams.get("limit") ?? "") || undefined;
        const offset = Number(searchParams.get("offset") ?? "") || undefined;
        const result = listApplicationRowsPaged(deps.db, {
          ...(searchParams.get("state") ? { state: searchParams.get("state")! } : {}),
          ...(searchParams.get("q") ? { q: searchParams.get("q")! } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(offset !== undefined ? { offset } : {}),
        });
        json(res, 200, result);
      },
    },
    {
      method: "GET",
      pattern: "/api/applications/:id",
      handler: ({ res, params }) => {
        const detail = getApplicationDetail(deps.db, params["id"]!);
        if (!detail) {
          json(res, 404, { error: `no such application: ${params["id"]}` });
          return;
        }
        json(res, 200, detail);
      },
    },
    {
      method: "GET",
      pattern: "/api/review-items",
      handler: ({ res, searchParams }) => {
        const status = searchParams.get("status") === "all" ? "all" : "open";
        json(
          res,
          200,
          listReviewItemViews(deps.db, {
            status,
            ...(searchParams.get("kind") ? { kind: searchParams.get("kind")! } : {}),
          }),
        );
      },
    },
    {
      method: "GET",
      pattern: "/api/submissions",
      handler: ({ res }) => json(res, 200, listSubmissionRows(deps.db)),
    },
    {
      method: "GET",
      pattern: "/api/drafts",
      handler: ({ res }) => json(res, 200, listDraftRows(deps.db)),
    },
    {
      method: "GET",
      pattern: "/api/fill-outcomes",
      handler: ({ res }) => json(res, 200, buildFillOutcomesView(deps.db)),
    },
    {
      method: "GET",
      pattern: "/api/artifacts",
      handler: ({ res, searchParams }) => {
        serveArtifact(res, deps.artifactsDir, searchParams.get("path") ?? "");
      },
    },
    ...buildMutationRoutes({ db: deps.db }),
    ...buildAutomationRoutes({ db: deps.db, token: deps.token }),
    ...(deps.runManager ? buildRunRoutes({ runManager: deps.runManager }) : []),
    ...(deps.gmailBroker ? buildGmailRoutes({ broker: deps.gmailBroker }) : []),
    ...(deps.extraRoutes ?? []),
  ];

  return (req, res) => handle(req, res);

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!checkHostHeader(req)) {
        json(res, 403, { error: "forbidden host" });
        return;
      }
      const method = req.method ?? "GET";
      if (method !== "GET" && method !== "POST") {
        json(res, 405, { error: "GET and POST only" });
        return;
      }

      let pathname: string;
      let searchParams: URLSearchParams;
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        pathname = url.pathname;
        searchParams = url.searchParams;
      } catch {
        json(res, 400, { error: "bad request" });
        return;
      }

      if (method === "POST" && !checkBearerToken(req, deps.token)) {
        json(res, 401, { error: "missing or invalid bearer token" });
        return;
      }

      const match = findRoute(routes, method, pathname);
      if (match) {
        await match.route.handler({ req, res, params: match.params, searchParams });
        return;
      }
      if (pathname.startsWith("/api/")) {
        json(res, 404, { error: `no such route: ${method} ${pathname}` });
        return;
      }
      if (method !== "GET") {
        json(res, 404, { error: `no such route: ${method} ${pathname}` });
        return;
      }
      serveStatic(res, deps.distDir, pathname);
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof BodyError) {
        json(res, err.statusCode, { error: err.message });
        return;
      }
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/** Stream one artifact file; the resolved path must stay inside artifactsDir. */
function serveArtifact(res: ServerResponse, artifactsDir: string, rel: string): void {
  if (!rel) {
    json(res, 400, { error: "path query parameter required" });
    return;
  }
  const root = path.resolve(artifactsDir);
  const resolved = path.resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    json(res, 403, { error: "path escapes the artifacts directory" });
    return;
  }
  const ext = path.extname(resolved).toLowerCase();
  if (!ARTIFACT_EXTENSIONS.has(ext)) {
    json(res, 403, { error: `artifact extension not allowed: ${ext || "(none)"}` });
    return;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    json(res, 404, { error: "no such artifact" });
    return;
  }
  const types: Record<string, string> = {
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".txt": "text/plain; charset=utf-8",
    ".html": "text/plain; charset=utf-8", // never render artifact HTML in the console origin
    ".md": "text/plain; charset=utf-8",
  };
  res.writeHead(200, {
    "content-type": types[ext] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  res.end(fs.readFileSync(resolved));
}

export function startConsole(input: {
  db: Db;
  distDir?: string;
}): Promise<{ server: Server; url: string; token: string }> {
  const cfg = getConfig();
  const token = generateBootToken();
  const distDir =
    input.distDir ?? path.resolve(process.cwd(), "frontend", "dist");
  const runManager = new RunManager({
    runsDir: path.join(cfg.artifactsDir, "console", "runs"),
  });
  // Restart = disarmed: any l3_session left RUNNING by a prior process is
  // swept before the server accepts requests.
  const swept = sweepStaleArmSessions(input.db);
  if (swept > 0) {
    logger.info("swept stale L3 arm sessions on boot", {
      service: "automation",
      action: "sweep",
      metadata: { swept },
    });
  }
  // Belt-and-suspenders auto-disarm: getArmStatus already treats an expired
  // row as disarmed, but this completes the row promptly so a watching UI
  // and the DB agree without waiting for the next status read.
  const expiryTimer = setInterval(() => {
    getArmStatus(input.db);
  }, 30_000);
  expiryTimer.unref?.();
  const handler = createConsoleHandler({
    db: input.db,
    token,
    distDir,
    artifactsDir: cfg.artifactsDir,
    runManager,
    gmailBroker: new GmailAuthBroker(),
  });
  const server = http.createServer(handler);
  server.once("close", () => {
    clearInterval(expiryTimer);
    runManager.shutdown();
  });
  // Cancel any active child, then exit — registering a SIGINT listener
  // suppresses Node's default terminate, so this must exit explicitly or
  // the first Ctrl+C would appear to do nothing.
  process.once("SIGINT", () => {
    runManager.shutdown();
    process.exit(130);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.consolePort, cfg.consoleHost, () => {
      const url = `http://${cfg.consoleHost}:${cfg.consolePort}/`;
      logger.info("console listening", {
        service: "console",
        action: "listen",
        metadata: { url },
      });
      resolve({ server, url, token });
    });
  });
}
