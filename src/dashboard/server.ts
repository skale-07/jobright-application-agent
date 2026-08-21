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

/**
 * The read-only dashboard: the oldest operator surface, kept because a
 * GET-only server with no mutation routes at all is a genuinely
 * different safety posture from the console. It was also the last
 * surface with no brand — four CSS rules and a #f5f5f5 box.
 *
 * It now carries the palette, both themes, and the type scale, written
 * out literally: this page ships as a string inside the server and has
 * no way to import tokens.css. tests/unit/design-tokens.test.ts checks
 * the colors here against the console palette so the copy cannot drift.
 */
const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Dispatch — dashboard (read-only)</title>
<style>
  :root {
    --bg: #f6f8fa; --bg-raised: #ffffff; --bg-inset: #eef1f4;
    --border: #d0d7de; --text: #1f2328; --text-dim: #59636e;
    --accent: #0969da; --ok: #1a7f37;
    --font-mono: "SFMono-Regular", ui-monospace, "Cascadia Code", Menlo, Consolas, monospace;
    --font-ui: "Inter Variable", "Inter", ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d1117; --bg-raised: #161b22; --bg-inset: #010409;
      --border: #30363d; --text: #e6edf3; --text-dim: #8b949e;
      --accent: #58a6ff; --ok: #3fb950;
    }
  }
  body {
    font-family: var(--font-ui); background: var(--bg); color: var(--text);
    margin: 0; padding: 2rem 1.5rem 4rem; line-height: 1.6;
  }
  main { max-width: 72rem; margin: 0 auto; }
  h1 { font-size: 1.25rem; margin: 0 0 0.25rem; }
  h2 { font-size: 1.05rem; margin: 2rem 0 0.5rem; }
  p.sub { color: var(--text-dim); font-size: 0.875rem; margin: 0 0 1.5rem; }
  nav { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  nav a {
    font-family: var(--font-mono); font-size: 0.78rem; color: var(--accent);
    background: var(--bg-raised); border: 1px solid var(--border);
    border-radius: 5px; padding: 0.3rem 0.7rem; text-decoration: none;
  }
  nav a:hover { border-color: var(--accent); }
  a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  pre {
    font-family: var(--font-mono); font-size: 0.78rem;
    background: var(--bg-inset); border: 1px solid var(--border);
    border-radius: 8px; padding: 1rem; overflow-x: auto;
    font-variant-numeric: tabular-nums;
  }
  .safe { color: var(--ok); font-family: var(--font-mono); font-size: 0.6875rem; }
</style>
</head>
<body>
<main>
<h1>Dispatch — read-only dashboard</h1>
<p class="sub">
  Bound to localhost only. <span class="safe">No mutation routes exist on this server.</span>
  For anything that acts, use the console.
</p>
<nav>
  <a href="/api/summary">summary</a>
  <a href="/api/applications">applications</a>
  <a href="/api/review-items">review items</a>
  <a href="/api/submissions">submissions</a>
  <a href="/api/drafts">drafts</a>
</nav>
<h2>Summary</h2>
<pre id="out">loading…</pre>
</main>
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
