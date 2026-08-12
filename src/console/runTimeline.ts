import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config/index.js";

/**
 * Run timeline: one self-contained HTML page that shows what the system
 * actually DID, in order, per application (operator request 2026-08-12:
 * "is there a way to visualize the agent's/system's operations so it's
 * easier to digest?"). Reads only artifacts already on disk — cycle
 * reports, navigation reports, and live-fill reports — and renders them
 * as a per-app lane with phases, walls, timings, and the notes that
 * explain each stop.
 *
 * Read-only by construction: nothing here touches the browser, the DB, or
 * the network, and the page is static HTML with no external requests.
 */

export type TimelineApp = {
  applicationId: string;
  company: string | null;
  role: string | null;
  outcome: string;
  wall: string | null;
  method: string | null;
  ats: string | null;
  durationMs: number | null;
  phases: Array<{ phase: string; outcome: string; evidence?: string }>;
  notes: string[];
  agent: { turns: number; steps: number; hosts: string[] } | null;
};

export type TimelineData = {
  generatedAt: string;
  cycle: {
    startedAt: string | null;
    outcome: string | null;
    agentLeg: string | null;
    defaultResume: string | null;
    appsStarted: number | null;
    submitsUsed: number | null;
    stoppedReason: string | null;
    notes: string[];
  } | null;
  apps: TimelineApp[];
};

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function newestFile(dir: string, match: (f: string) => boolean): string | null {
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter(match)
    .map((f) => path.join(dir, f))
    .filter((f) => fs.statSync(f).isFile());
  if (files.length === 0) return null;
  return files.sort(
    (a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs,
  )[0]!;
}

/** Gather the newest cycle + the N most recent navigation reports. */
export function collectTimeline(
  input: { limit?: number; artifactsDir?: string } = {},
): TimelineData {
  const limit = input.limit ?? 25;
  const root = input.artifactsDir ?? getConfig().artifactsDir;

  const cycleFile = newestFile(
    path.join(root, "console", "auto-cycle"),
    (f) => f.startsWith("cycle-") && f.endsWith(".json"),
  );
  const cycleRaw = cycleFile
    ? readJson<Record<string, unknown>>(cycleFile)
    : null;
  const session = (cycleRaw?.["session"] ?? null) as Record<string, unknown> | null;
  const preflight = (cycleRaw?.["preflight"] ?? {}) as Record<string, unknown>;
  const cycle = cycleRaw
    ? {
        startedAt: (cycleRaw["started_at"] as string) ?? null,
        outcome: (cycleRaw["outcome"] as string) ?? null,
        agentLeg: (preflight["agent_leg"] as string) ?? null,
        defaultResume: (preflight["default_resume"] as string) ?? null,
        appsStarted: (session?.["apps_started"] as number) ?? null,
        submitsUsed: (session?.["submits_used"] as number) ?? null,
        stoppedReason: (session?.["stopped_reason"] as string) ?? null,
        notes: ((session?.["notes"] as string[]) ?? []).slice(0, 40),
      }
    : null;

  const navDir = path.join(root, "navigation");
  const apps: TimelineApp[] = [];
  if (fs.existsSync(navDir)) {
    const runs = fs
      .readdirSync(navDir)
      .map((d) => path.join(navDir, d, "report.json"))
      .filter((f) => fs.existsSync(f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
      .slice(0, limit);
    for (const file of runs) {
      const r = readJson<Record<string, unknown>>(file);
      if (!r) continue;
      const agent = r["agent"] as
        | { turns_used?: number; steps_used?: number; domains_visited?: string[] }
        | null;
      const congruence = r["congruence"] as { expected_company?: string } | null;
      apps.push({
        applicationId: String(r["application_id"] ?? "").slice(0, 8),
        company: congruence?.expected_company ?? null,
        role: null,
        outcome: r["resolved_url"] ? "resolved" : `wall: ${String(r["wall"])}`,
        wall: (r["wall"] as string) ?? null,
        method: (r["method"] as string) ?? null,
        ats: (r["resolved_ats"] as string) ?? null,
        durationMs: null,
        phases: ((r["phase_trace"] as TimelineApp["phases"]) ?? []).slice(0, 12),
        notes: ((r["notes"] as string[]) ?? []).slice(0, 12),
        agent: agent
          ? {
              turns: agent.turns_used ?? 0,
              steps: agent.steps_used ?? 0,
              hosts: (agent.domains_visited ?? []).slice(0, 8),
            }
          : null,
      });
    }
  }

  return { generatedAt: new Date().toISOString(), cycle, apps };
}

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Wall → colour token. Resolved is the only "good" state. */
function toneFor(app: TimelineApp): string {
  if (app.wall === "none" || app.method) return "ok";
  if (app.wall === "closed") return "muted";
  if (app.wall === "auth" || app.wall === "captcha" || app.wall === "phone_otp") {
    return "warn";
  }
  return "bad";
}

export function renderTimelineHtml(data: TimelineData): string {
  const rows = data.apps
    .map((app) => {
      const phases = app.phases
        .map(
          (p) =>
            `<li><b>${esc(p.phase)}</b> — ${esc(p.outcome)}${
              p.evidence ? `<span class="ev">${esc(p.evidence)}</span>` : ""
            }</li>`,
        )
        .join("");
      const notes = app.notes
        .map((n) => `<li>${esc(n)}</li>`)
        .join("");
      return `<details class="app ${toneFor(app)}">
  <summary>
    <span class="id">${esc(app.applicationId)}</span>
    <span class="co">${esc(app.company ?? "—")}</span>
    <span class="badge">${esc(app.outcome)}</span>
    ${app.method ? `<span class="chip">${esc(app.method)}</span>` : ""}
    ${app.ats ? `<span class="chip">${esc(app.ats)}</span>` : ""}
    ${app.agent ? `<span class="chip">agent ${app.agent.turns}t/${app.agent.steps}s</span>` : ""}
  </summary>
  <div class="body">
    <h4>Phases</h4><ol class="phases">${phases || "<li>none recorded</li>"}</ol>
    <h4>Notes</h4><ul class="notes">${notes || "<li>none</li>"}</ul>
    ${app.agent && app.agent.hosts.length > 0 ? `<h4>Hosts visited</h4><p class="hosts">${app.agent.hosts.map(esc).join(" → ")}</p>` : ""}
  </div>
</details>`;
    })
    .join("\n");

  const c = data.cycle;
  const cycleBlock = c
    ? `<section class="cycle">
  <h2>Latest cycle</h2>
  <dl>
    <div><dt>Started</dt><dd>${esc(c.startedAt)}</dd></div>
    <div><dt>Outcome</dt><dd>${esc(c.outcome)}</dd></div>
    <div><dt>Agent leg</dt><dd>${esc(c.agentLeg ?? "—")}</dd></div>
    <div><dt>Default resume</dt><dd>${esc(c.defaultResume ?? "—")}</dd></div>
    <div><dt>Apps started</dt><dd>${esc(c.appsStarted ?? "—")}</dd></div>
    <div><dt>Submits used</dt><dd>${esc(c.submitsUsed ?? "—")}</dd></div>
    <div><dt>Stopped</dt><dd>${esc(c.stoppedReason ?? "—")}</dd></div>
  </dl>
  ${c.notes.length > 0 ? `<h3>Session notes</h3><ul class="notes">${c.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
</section>`
    : `<section class="cycle"><h2>Latest cycle</h2><p>No cycle report found under artifacts/console/auto-cycle.</p></section>`;

  const counts = data.apps.reduce<Record<string, number>>((acc, a) => {
    const key = a.method ? "resolved" : (a.wall ?? "unknown");
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<span class="stat"><b>${v}</b> ${esc(k)}</span>`)
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dispatch run timeline</title>
<style>
  :root {
    --bg:#fbfbfd; --fg:#14161a; --muted:#6b7280; --line:#e5e7eb; --card:#fff;
    --ok:#0f9d58; --warn:#d97706; --bad:#dc2626; --dim:#9ca3af;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg:#0f1115; --fg:#e6e8eb; --muted:#9aa3af; --line:#232732; --card:#161922;
    }
  }
  :root[data-theme="dark"] {
    --bg:#0f1115; --fg:#e6e8eb; --muted:#9aa3af; --line:#232732; --card:#161922;
  }
  body { margin:0; background:var(--bg); color:var(--fg);
    font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  .wrap { max-width:1040px; margin:0 auto; padding:32px 20px 64px; }
  h1 { font-size:24px; margin:0 0 4px; letter-spacing:-.01em; }
  .sub { color:var(--muted); margin:0 0 24px; font-size:13px; }
  section.cycle { background:var(--card); border:1px solid var(--line);
    border-radius:12px; padding:18px 20px; margin-bottom:24px; }
  h2 { font-size:16px; margin:0 0 12px; }
  h3 { font-size:13px; margin:16px 0 6px; color:var(--muted);
    text-transform:uppercase; letter-spacing:.06em; }
  dl { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr));
    gap:10px 18px; margin:0; }
  dl div { min-width:0; }
  dt { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.05em; }
  dd { margin:2px 0 0; font-size:13px; word-break:break-word; }
  .stats { display:flex; flex-wrap:wrap; gap:8px; margin:0 0 18px; }
  .stat { background:var(--card); border:1px solid var(--line); border-radius:999px;
    padding:4px 12px; font-size:12px; color:var(--muted); }
  .stat b { color:var(--fg); }
  details.app { background:var(--card); border:1px solid var(--line);
    border-left:3px solid var(--dim); border-radius:10px; margin-bottom:8px; }
  details.app.ok { border-left-color:var(--ok); }
  details.app.warn { border-left-color:var(--warn); }
  details.app.bad { border-left-color:var(--bad); }
  details.app.muted { border-left-color:var(--dim); }
  summary { cursor:pointer; padding:11px 16px; display:flex; flex-wrap:wrap;
    align-items:center; gap:10px; list-style:none; }
  summary::-webkit-details-marker { display:none; }
  .id { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; color:var(--muted); }
  .co { font-weight:600; }
  .badge { font-size:12px; color:var(--muted); }
  .chip { font-size:11px; border:1px solid var(--line); border-radius:999px;
    padding:1px 8px; color:var(--muted); }
  .body { padding:0 16px 16px; border-top:1px solid var(--line); }
  h4 { font-size:12px; margin:14px 0 6px; color:var(--muted);
    text-transform:uppercase; letter-spacing:.05em; }
  ol.phases, ul.notes { margin:0; padding-left:20px; font-size:13px; }
  ol.phases li, ul.notes li { margin:3px 0; word-break:break-word; }
  .ev { display:block; color:var(--muted); font-size:12px; }
  .hosts { font-family:ui-monospace,monospace; font-size:12px; color:var(--muted);
    word-break:break-all; margin:0; }
  footer { color:var(--muted); font-size:12px; margin-top:28px; }
</style></head>
<body><div class="wrap">
<h1>Dispatch run timeline</h1>
<p class="sub">Generated ${esc(data.generatedAt)} · ${data.apps.length} navigation run(s) · read-only view of artifacts/</p>
<div class="stats">${summary}</div>
${cycleBlock}
<h2>Applications</h2>
${rows || "<p>No navigation reports found under artifacts/navigation.</p>"}
<footer>Every row is one navigation run. Green = employer URL resolved; amber = auth/CAPTCHA wall; red = unresolved; grey = posting closed. Expand a row for its phase trace and the notes that explain the stop.</footer>
</div></body></html>`;
}

/** Write the timeline next to the other console artifacts; returns the path. */
export function writeRunTimeline(
  input: { limit?: number; artifactsDir?: string } = {},
): string {
  const root = input.artifactsDir ?? getConfig().artifactsDir;
  const data = collectTimeline(input);
  const outDir = path.join(root, "console");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "run-timeline.html");
  fs.writeFileSync(outPath, renderTimelineHtml(data), "utf8");
  return outPath;
}
