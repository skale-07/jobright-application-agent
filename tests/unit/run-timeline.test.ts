import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectTimeline,
  renderTimelineHtml,
  writeRunTimeline,
} from "../../src/console/runTimeline.js";

/**
 * Run timeline (operator request 2026-08-12: "is there a way to visualize
 * the agent's/system's operations so it's easier to digest?"). The page is
 * built ONLY from artifacts already on disk — these tests seed a fake
 * artifacts tree and assert the render is complete, escaped, and
 * self-contained (no external requests, which would leak run data).
 */
describe("run timeline (UNIT_CONFIRMED)", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-timeline-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function seedNav(id: string, report: Record<string, unknown>): void {
    const dir = path.join(root, "navigation", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "report.json"),
      JSON.stringify({ application_id: id, ...report }),
    );
  }

  function seedCycle(report: Record<string, unknown>): void {
    const dir = path.join(root, "console", "auto-cycle");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "cycle-2026-08-12T22-00-00-000Z.json"),
      JSON.stringify(report),
    );
  }

  it("collects the newest cycle plus per-app navigation runs", () => {
    seedCycle({
      started_at: "2026-08-12T22:00:00.000Z",
      outcome: "completed",
      preflight: { agent_leg: "available", default_resume: "ready (resume.pdf)" },
      session: {
        apps_started: 3,
        submits_used: 0,
        stopped_reason: "queue_drained",
        notes: ["nav requeue: 2 applications"],
      },
    });
    seedNav("aaaaaaaa-1111", {
      resolved_url: "https://boards.greenhouse.io/x/jobs/1",
      resolved_ats: "greenhouse",
      method: "anchor_href",
      wall: "none",
      congruence: { expected_company: "Acme" },
      phase_trace: [{ phase: "open", outcome: "job page loaded" }],
      notes: ["Apply control: autofill CTA (tier 0)"],
      agent: { turns_used: 2, steps_used: 9, domains_visited: ["acme.com"] },
    });
    seedNav("bbbbbbbb-2222", {
      resolved_url: null,
      wall: "auth",
      method: null,
      congruence: { expected_company: "ByteDance" },
      phase_trace: [{ phase: "agent", outcome: "parked at login wall" }],
      notes: ["login wall on jobs.bytedance.com: sign_in_form"],
    });

    const data = collectTimeline({ artifactsDir: root });
    expect(data.cycle?.outcome).toBe("completed");
    expect(data.cycle?.agentLeg).toBe("available");
    expect(data.cycle?.appsStarted).toBe(3);
    expect(data.apps).toHaveLength(2);
    const byCompany = Object.fromEntries(data.apps.map((a) => [a.company, a]));
    expect(byCompany["Acme"]?.method).toBe("anchor_href");
    expect(byCompany["Acme"]?.agent).toMatchObject({ turns: 2, steps: 9 });
    expect(byCompany["ByteDance"]?.wall).toBe("auth");
    expect(byCompany["ByteDance"]?.outcome).toBe("wall: auth");
  });

  it("renders a self-contained page — no external requests, walls colour-coded", () => {
    seedCycle({ started_at: "t", outcome: "completed", session: { notes: [] } });
    seedNav("cccccccc-3333", {
      resolved_url: "https://jobs.lever.co/x/1",
      method: "apply_click",
      wall: "none",
      congruence: { expected_company: "Lever Co" },
      phase_trace: [],
      notes: [],
    });
    seedNav("dddddddd-4444", {
      resolved_url: null,
      wall: "closed",
      congruence: { expected_company: "Shut Co" },
      phase_trace: [],
      notes: ["jobright banner says this job has closed"],
    });

    const html = renderTimelineHtml(collectTimeline({ artifactsDir: root }));
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain("Lever Co");
    expect(html).toContain("Shut Co");
    // Resolved is green; a closed posting is muted, not an error.
    expect(html).toMatch(/details class="app ok"/);
    expect(html).toMatch(/details class="app muted"/);
    // Self-contained: nothing is fetched from the network when opened.
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/src=["']https?:/i);
    expect(html).not.toMatch(/<link[^>]+href=["']https?:/i);
    // Theme-aware in both directions (viewer may be light, dark, or system).
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain('[data-theme="dark"]');
  });

  it("escapes artifact text — a note can never inject markup", () => {
    seedNav("eeeeeeee-5555", {
      resolved_url: null,
      wall: "unknown",
      congruence: { expected_company: "<img src=x onerror=alert(1)>" },
      phase_trace: [],
      notes: ["</details><script>alert('x')</script>"],
    });
    const html = renderTimelineHtml(collectTimeline({ artifactsDir: root }));
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders an honest empty state instead of failing when nothing has run", () => {
    const html = renderTimelineHtml(collectTimeline({ artifactsDir: root }));
    expect(html).toContain("No cycle report found");
    expect(html).toContain("No navigation reports found");
  });

  it("writes the page under artifacts/console and returns its path", () => {
    seedNav("ffffffff-6666", {
      resolved_url: "https://x.ashbyhq.com/y",
      method: "anchor_href",
      wall: "none",
      congruence: { expected_company: "Ashby Co" },
      phase_trace: [],
      notes: [],
    });
    const out = writeRunTimeline({ artifactsDir: root });
    expect(out).toBe(path.join(root, "console", "run-timeline.html"));
    expect(fs.readFileSync(out, "utf8")).toContain("Ashby Co");
  });
});
