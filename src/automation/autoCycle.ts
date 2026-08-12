import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getConfig, resetConfigCache } from "../config/index.js";
import { writeJsonAtomic } from "../storage/atomicJson.js";
import { logger } from "../logging/logger.js";
import type { Db } from "../storage/db/client.js";
import { migrate, openDatabase } from "../storage/db/client.js";
import {
  armSession,
  disarmSession,
  getActiveArmSession,
  getArmStatus,
  sweepAbandonedArmSessions,
  hashArmToken,
  type ArmStatus,
} from "./armSession.js";
import {
  runAutomationSession,
  type AutomationSessionReport,
} from "./worker.js";
import {
  autopushArtifacts,
  type ArtifactAutopushReport,
} from "./artifactAutopush.js";
import { ensureCdpChrome, type EnsureCdpReport } from "./cdpChrome.js";

/**
 * Hands-off cycle for the OPERATOR'S OWN MACHINE — the "coding in loops"
 * runtime leg when the human cannot be at the desktop. Installed once as a
 * scheduled task (operator-guide §19); each firing:
 *
 *   1. self-updates (git pull --ff-only origin master, npm install when the
 *      lockfile moved, frontend build when frontend/ moved),
 *   2. preflights the environment deterministically (typecheck + the same
 *      env coherence the console ceiling would enforce),
 *   3. arms a session with the standard defaults and runs the SAME
 *      autonomous worker the console button runs,
 *   4. lets the worker's post-session batches (essays, predictions,
 *      artifact autopush) close the loop back to the analysis agent.
 *
 * Governance: installing/enabling the scheduled task IS the standing human
 * authorization — the task's environment carries every capability flag,
 * so deleting the task, or flipping AUTOMATION_ENABLED off in it, kills
 * everything. Every in-run gate (arm budget, submit gates, walls, caps)
 * is unchanged: this module only automates the two button presses the
 * operator used to do by hand (arm + start). Refusals are loud and the
 * cycle NEVER weakens a gate to proceed.
 */

export type AutoCycleReport = {
  started_at: string;
  updated: { pulled: boolean; head: string | null; installed: boolean; notes: string[] };
  preflight: {
    ok: boolean;
    notes: string[];
    /**
     * Whether the nav agent phase (phase C) would run in this environment —
     * "available" or the named cause. Advisory, never a refusal: the
     * deterministic phases still run without it, but a session where every
     * app needs the agent (the 4a7c199b run: 7/7) is wasted silently
     * without this line telling the operator which lever to pull.
     */
    agent_leg?: string;
    /**
     * Default resume readiness. 8 of 14 apps in session 60a3693f died at
     * MATERIALS_GENERATING because DEFAULT_RESUME_PATH still pointed at
     * the example placeholder — a per-app warning nobody reads. Say it
     * once, up front, where the operator will see it.
     */
    default_resume?: string;
  };
  arm: ArmStatus | null;
  session: AutomationSessionReport | null;
  outcome: "completed" | "refused" | "skipped_already_armed" | "error";
  notes: string[];
};

/**
 * Windows ships npm/npx as .cmd shims, which execFileSync cannot spawn
 * directly (ENOENT — and since Node's CVE-2024-27980 hardening, EINVAL
 * even with an explicit .cmd path unless a shell is used). shell:true on
 * win32 resolves the shims; every argument this module passes is a fixed
 * literal, so nothing user-controlled ever reaches that shell.
 */
export function execOptionsForPlatform(platform: NodeJS.Platform): {
  encoding: "utf8";
  timeout: number;
  shell: boolean;
} {
  return {
    encoding: "utf8",
    timeout: 600_000,
    shell: platform === "win32",
  };
}

export type AutoCycleSeams = {
  /** Test seam: replaces child-process execution (git/npm). */
  exec?: (command: string, args: string[]) => string;
  /** Test seam: replaces the worker. */
  sessionRunner?: (db: Db, armRunId: string) => Promise<AutomationSessionReport>;
  /** Test seam: replaces the cycle-report artifact push. */
  artifactPusher?: (input: {
    armRunId: string;
    message?: string;
  }) => Promise<ArtifactAutopushReport>;
  /** Test seam: replaces the CDP reachability probe. */
  probeCdp?: (cdpUrl: string) => Promise<boolean>;
  /** Test seam: replaces the detached debug-Chrome spawn. */
  chromeSpawner?: (command: string, args: string[]) => void;
  db?: Db;
  now?: () => Date;
};

const REQUIRED_FLAGS: Array<{ key: string; check: (cfg: ReturnType<typeof getConfig>) => boolean }> = [
  { key: "AUTOMATION_ENABLED", check: (c) => c.automationEnabled },
  { key: "FORM_FILL_ENABLED", check: (c) => c.formFillEnabled },
  { key: "SUBMIT_ENABLED", check: (c) => c.submitEnabled },
  { key: "NAVIGATION_ENABLED", check: (c) => c.navigationEnabled },
  { key: "DRY_RUN=false", check: (c) => !c.dryRun },
];

export async function runAutoCycle(
  input: {
    skipUpdate?: boolean;
    durationMinutes?: number;
    maxSubmits?: number;
    maxApps?: number;
    headless?: boolean;
  } = {},
  seams: AutoCycleSeams = {},
): Promise<AutoCycleReport> {
  const report = await runAutoCycleInner(input, seams);
  // Persist the cycle-level report — the first hands-off run's summary
  // existed only in the operator's terminal, so the analysis loop had
  // per-app artifacts but no session frame (stop reason, refusals, update
  // state).
  try {
    const cfg = getConfig();
    const stamp = report.started_at.replace(/[:.]/g, "-");
    const outPath = path.join(
      cfg.artifactsDir,
      "console",
      "auto-cycle",
      `cycle-${stamp}.json`,
    );
    writeJsonAtomic(outPath, report as unknown as Record<string, unknown>);
    // Render the human-readable timeline from the artifacts this cycle
    // just wrote (operator request 2026-08-12: "is there a way to
    // visualize the system's operations so it's easier to digest?").
    // Read-only, artifacts-only — it must never fail the cycle, so it
    // shares the surrounding try/catch and rides the same push.
    try {
      const { writeRunTimeline } = await import("../console/runTimeline.js");
      report.notes.push(`run timeline: ${writeRunTimeline({ limit: 40 })}`);
    } catch (err) {
      report.notes.push(
        `run timeline render failed (cycle unaffected): ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`,
      );
    }
    // The worker's autopush runs INSIDE the session — before this report
    // exists — so session 4a7c199b's push carried per-app artifacts but no
    // cycle frame, and a refused cycle pushed nothing at all. Ship the
    // report on its own follow-up push (same staging rules, same secret
    // gate, fail-open into notes).
    if (cfg.artifactAutopushEnabled) {
      const push = await (seams.artifactPusher ?? autopushArtifacts)({
        armRunId: report.arm?.arm_run_id ?? "auto-cycle",
        message: `art: auto-cycle report ${stamp} (autopush)`,
      });
      report.notes.push(...push.notes);
    }
  } catch (err) {
    // reporting is telemetry — never fail the cycle over it
    report.notes.push(
      `cycle report persist/push failed (cycle unaffected): ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`,
    );
  }
  return report;
}

async function runAutoCycleInner(
  input: {
    skipUpdate?: boolean;
    durationMinutes?: number;
    maxSubmits?: number;
    maxApps?: number;
    headless?: boolean;
  },
  seams: AutoCycleSeams,
): Promise<AutoCycleReport> {
  const now = seams.now ?? (() => new Date());
  const exec =
    seams.exec ??
    ((command: string, args: string[]): string =>
      execFileSync(command, args, execOptionsForPlatform(process.platform)));

  const report: AutoCycleReport = {
    started_at: now().toISOString(),
    updated: { pulled: false, head: null, installed: false, notes: [] },
    preflight: { ok: false, notes: [] },
    arm: null,
    session: null,
    outcome: "error",
    notes: [],
  };

  // ---- 1. Self-update (fail-open into notes: an offline machine still runs
  // the code it has; a conflicted tree refuses loudly instead of guessing).
  if (!input.skipUpdate) {
    try {
      const before = exec("git", ["rev-parse", "HEAD"]).trim();
      exec("git", ["fetch", "origin", "master"]);
      exec("git", ["merge", "--ff-only", "origin/master"]);
      const after = exec("git", ["rev-parse", "HEAD"]).trim();
      report.updated.pulled = before !== after;
      report.updated.head = after.slice(0, 8);
      if (report.updated.pulled) {
        const changed = exec("git", ["diff", "--name-only", before, after]);
        if (/package-lock\.json/.test(changed)) {
          exec("npm", ["install", "--no-audit", "--no-fund"]);
          report.updated.installed = true;
        }
        if (/^frontend\//m.test(changed)) {
          exec("npm", ["run", "frontend:build"]);
          report.updated.notes.push("frontend rebuilt");
        }
        report.updated.notes.push(`updated to ${report.updated.head}`);
      }
    } catch (err) {
      report.updated.notes.push(
        `self-update failed (running current code): ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
      );
    }
  } else {
    report.updated.notes.push("update skipped (--no-update)");
  }

  // ---- 2. Deterministic preflight. Config is re-read AFTER the pull so a
  // merged flag-list change is honored; the typecheck catches a broken pull
  // before any browser opens.
  resetConfigCache();
  const cfg = getConfig();
  for (const flag of REQUIRED_FLAGS) {
    if (!flag.check(cfg)) {
      report.preflight.notes.push(`refusing: ${flag.key} not satisfied in the task environment`);
    }
  }
  if (cfg.submitRequiresLocalConfirmation) {
    report.preflight.notes.push(
      "refusing: SUBMIT_REQUIRES_LOCAL_CONFIRMATION must be false in the task environment (the arm row budget is the control)",
    );
  }
  // Advisory only: name a missing default resume before the queue burns.
  try {
    const resumePath = path.isAbsolute(cfg.defaultResumePath)
      ? cfg.defaultResumePath
      : path.join(process.cwd(), cfg.defaultResumePath);
    report.preflight.default_resume = fs.existsSync(resumePath)
      ? `ready (${cfg.defaultResumePath})`
      : `MISSING at ${cfg.defaultResumePath} — every app with no registered resume will park at materials. Point DEFAULT_RESUME_PATH in .env at your real resume.`;
  } catch {
    report.preflight.default_resume = "unknown";
  }

  // Advisory only — a cycle without the agent leg still runs (phases A/B
  // resolve some apps), but the operator must SEE it before the session
  // burns the queue, not archaeologize it from seven identical nav reports.
  // With CDP_AUTOLAUNCH_ENABLED the cycle repairs the common case itself:
  // the scheduled task fired while the debug Chrome was closed.
  try {
    if (!cfg.agentFallbackEnabled) {
      report.preflight.agent_leg =
        "UNAVAILABLE — AGENT_FALLBACK_ENABLED is off; nav phase C will be skipped for every app";
    } else {
      const cdp: EnsureCdpReport = await ensureCdpChrome({
        ...(seams.probeCdp ? { probe: seams.probeCdp } : {}),
        ...(seams.chromeSpawner ? { spawner: seams.chromeSpawner } : {}),
      });
      report.notes.push(...cdp.notes);
      report.preflight.agent_leg = cdp.reachable
        ? cdp.launched
          ? "available (debug Chrome autolaunched)"
          : "available"
        : `UNAVAILABLE — CDP Chrome unreachable at ${cfg.agentCdpUrl}; nav phase C will be skipped for every app`;
    }
  } catch (err) {
    report.preflight.agent_leg = `probe failed: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`;
  }
  if (report.preflight.notes.length === 0 && !input.skipUpdate) {
    try {
      exec("npm", ["run", "typecheck"]);
    } catch (err) {
      // Name the ACTUAL failure: a spawn error (ENOENT on a machine where
      // npm resolution breaks) must never masquerade as a bad tree.
      report.preflight.notes.push(
        `refusing: typecheck failed after self-update: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
      );
    }
  }
  report.preflight.ok = report.preflight.notes.length === 0;
  if (!report.preflight.ok) {
    report.outcome = "refused";
    logger.warn("auto-cycle refused", {
      service: "automation",
      action: "auto_cycle_refused",
      metadata: { notes: report.preflight.notes },
    });
    return report;
  }

  // ---- 3. Arm + run — the same worker the console button runs.
  let ownedDb = false;
  let armedByThisCycle = false;
  const db =
    seams.db ??
    (() => {
      ownedDb = true;
      const d = openDatabase();
      migrate(d);
      return d;
    })();
  try {
    // NOT sweepStaleArmSessions: that is console-BOOT semantics (kill every
    // running arm). A live arm someone else holds must survive this cycle;
    // getActiveArmSession already completes genuinely expired rows itself.
    //
    // An ABANDONED arm is different from a live one. Live 2026-08-12: a
    // session was killed mid-run, its row stayed RUNNING, and the next
    // three scheduled cycles each read "already armed" and exited 0
    // without touching an application — a silent no-op schedule. A worker
    // heartbeats every iteration, so a row that has gone quiet has no
    // worker; complete it and proceed. Completing a row can only ever
    // REMOVE unattended-submit budget, never add any.
    for (const swept of sweepAbandonedArmSessions(db, { now: now() })) {
      report.notes.push(
        `swept abandoned arm ${swept.arm_run_id.slice(0, 8)} — no worker heartbeat for ${Math.round(
          swept.silent_for_ms / 60_000,
        )} min (a killed session left it RUNNING)`,
      );
    }
    if (getActiveArmSession(db, now())) {
      report.arm = getArmStatus(db, now());
      report.outcome = "skipped_already_armed";
      // Say who is holding it and how far along — "skipped" with no detail
      // reads as a bug when it is really another session still working.
      report.notes.push(
        `an armed session is already live — not double-arming (arm ${
          report.arm.arm_run_id?.slice(0, 8) ?? "?"
        }, ${report.arm.apps_started}/${report.arm.max_apps} apps, ${Math.round(
          report.arm.seconds_remaining / 60,
        )} min left)`,
      );
      return report;
    }
    armedByThisCycle = true;
    report.arm = armSession(
      db,
      {
        ...(input.durationMinutes !== undefined
          ? { durationMinutes: input.durationMinutes }
          : {}),
        ...(input.maxSubmits !== undefined ? { maxSubmits: input.maxSubmits } : {}),
        ...(input.maxApps !== undefined ? { maxApps: input.maxApps } : {}),
        armedByTokenHash: hashArmToken("auto-cycle"),
      },
      now(),
    );
    const armRunId = report.arm.arm_run_id;
    if (!armRunId) {
      report.outcome = "error";
      report.notes.push("arm produced no run id");
      return report;
    }
    const runner =
      seams.sessionRunner ??
      ((database: Db, id: string) =>
        runAutomationSession({
          db: database,
          armRunId: id,
          headless: input.headless ?? false,
          discoverMax: report.arm?.discover_max ?? 8,
        }));
    report.session = await runner(db, armRunId);
    report.outcome = "completed";
    return report;
  } catch (err) {
    report.notes.push(
      `cycle error: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`,
    );
    report.outcome = "error";
    return report;
  } finally {
    // Restart-=-disarmed law, scheduled edition: never leave OUR arm live
    // past the cycle that created it. An arm someone ELSE holds (console
    // session in progress) is never touched.
    try {
      if (armedByThisCycle && getActiveArmSession(db, now())) {
        disarmSession(db, now());
      }
    } catch {
      // sweep on next cycle
    }
    if (ownedDb) db.close();
  }
}
