import fs from "node:fs";
import path from "node:path";
import type { ServerResponse } from "node:http";

/**
 * Static serving for the built frontend (frontend/dist) with SPA fallback.
 * Traversal-guarded: only files that resolve inside distDir are served.
 */

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

const PLACEHOLDER_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>operator console</title>
<style>body{font-family:ui-monospace,monospace;margin:3rem;max-width:40rem}</style>
</head><body>
<h1>operator console</h1>
<p>The frontend has not been built yet. Run:</p>
<pre>npm run frontend:install
npm run frontend:build</pre>
<p>then restart <code>npm run console</code>. The JSON API under <code>/api/</code> is live.</p>
</body></html>`;

export function serveStatic(
  res: ServerResponse,
  distDir: string,
  pathname: string,
): void {
  const indexPath = path.join(distDir, "index.html");
  if (!fs.existsSync(indexPath)) {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(PLACEHOLDER_HTML);
    return;
  }

  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolved = path.resolve(distDir, rel);
  const root = path.resolve(distDir);
  const inside =
    resolved === root || resolved.startsWith(root + path.sep);
  const target =
    inside && fs.existsSync(resolved) && fs.statSync(resolved).isFile()
      ? resolved
      : indexPath; // SPA fallback (also swallows traversal attempts safely)

  const ext = path.extname(target).toLowerCase();
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
    "cache-control": target === indexPath ? "no-store" : "public, max-age=3600",
  });
  res.end(fs.readFileSync(target));
}
