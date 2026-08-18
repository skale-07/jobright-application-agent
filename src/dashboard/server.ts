import http, {
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { URL } from "node:url";
import { getConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import type { Db } from "../storage/db/client.js";
import {
  buildReportSummary,
  listApplicationRows,
  listDraftRows,
  listReviewItemRows,
  listSubmissionRows,
} from "./reportData.js";

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Dispatch — dashboard (read-only)</title>
<style>
  body { font-family: ui-monospace, monospace; margin: 2rem; max-width: 72rem; }
  h1 { font-size: 1.2rem; } h2 { font-size: 1rem; margin-top: 1.5rem; }
  pre { background: #f5f5f5; padding: 1rem; overflow-x: auto; }
  a { margin-right: 1rem; }
</style>
</head>
<body>
<h1>Dispatch — read-only dashboard</h1>
<p>Bound to localhost only. No mutation routes exist.</p>
<nav>
  <a href="/api/summary">summary</a>
  <a href="/api/applications">applications</a>
  <a href="/api/review-items">review items</a>
  <a href="/api/submissions">submissions</a>
  <a href="/api/drafts">drafts</a>
</nav>
<h2>Summary</h2>
<pre id="out">loading…</pre>
<script>
  fetch("/api/summary").then(r => r.json()).then(d => {
    document.getElementById("out").textContent = JSON.stringify(d, null, 2);
  }).catch(e => {
    document.getElementById("out").textContent = String(e);
  });
</script>
</body>
</html>`;

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

/**
 * GET-only handler over the SQLite state. By construction there are no
 * mutation routes: every non-GET method is 405 before any routing happens.
 * Exported separately from the server for direct-invocation tests.
 */
export function createDashboardHandler(
  db: Db,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    if (req.method !== "GET") {
      json(res, 405, { error: "read-only dashboard — GET only" });
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

    try {
      switch (pathname) {
        case "/":
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(INDEX_HTML);
          return;
        case "/api/summary":
          json(res, 200, buildReportSummary(db));
          return;
        case "/api/applications": {
          const state = searchParams.get("state") ?? undefined;
          json(res, 200, listApplicationRows(db, state));
          return;
        }
        case "/api/review-items":
          json(res, 200, listReviewItemRows(db));
          return;
        case "/api/submissions":
          json(res, 200, listSubmissionRows(db));
          return;
        case "/api/drafts":
          json(res, 200, listDraftRows(db));
          return;
        default:
          json(res, 404, { error: `no such route: ${pathname}` });
          return;
      }
    } catch (err) {
      json(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

/**
 * Bind strictly to the configured host — env validation already rejects
 * anything other than 127.0.0.1/localhost (src/config/env.ts).
 */
export function startDashboard(input: {
  db: Db;
}): Promise<{ server: Server; url: string }> {
  const cfg = getConfig();
  const server = http.createServer(createDashboardHandler(input.db));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.dashboardPort, cfg.dashboardHost, () => {
      const url = `http://${cfg.dashboardHost}:${cfg.dashboardPort}/`;
      logger.info("dashboard listening", {
        service: "dashboard",
        action: "listen",
        metadata: { url },
      });
      resolve({ server, url });
    });
  });
}
