import { spawn } from "node:child_process";
import fs from "node:fs";
import { getConfig } from "../config/index.js";
import {
  cdpUserDataDir,
  defaultCdpUrl,
  findChromeExecutable,
} from "../auth/loginFlow.js";
import { probeCdpEndpoint } from "../navigation/runNavigation.js";

/**
 * Ensure the operator's debug Chrome (the CDP endpoint the nav agent
 * attaches to) is running — launching it if the operator opted in with
 * CDP_AUTOLAUNCH_ENABLED. This exists because session 4a7c199b burned its
 * whole queue behind "CDP Chrome unreachable": the scheduled cycle fired
 * while the debug Chrome was closed, and nothing could start it.
 *
 * Same executable + same persistent profile as `npm run chrome:debug:jobright`
 * (src/auth/loginFlow.ts helpers), so the JobRight/Gmail logins the operator
 * performed once in that profile survive across launches. This launches the
 * operator's REAL Chrome as a detached OS process — it is not chromium.launch
 * and it is not a browser this process owns; the session seams still attach
 * to it via CDP like they always did.
 *
 * Fail-closed: without the flag this function only probes and reports.
 * Bounded: one spawn attempt, then a finite readiness poll.
 */
export type EnsureCdpReport = {
  reachable: boolean;
  launched: boolean;
  notes: string[];
};

export type EnsureCdpSeams = {
  probe?: (cdpUrl: string) => Promise<boolean>;
  /** Test seam: replaces the detached OS spawn. */
  spawner?: (command: string, args: string[]) => void;
  sleep?: (ms: number) => Promise<void>;
};

const READINESS_POLLS = 10;
const POLL_INTERVAL_MS = 1_500;

export async function ensureCdpChrome(
  seams: EnsureCdpSeams = {},
): Promise<EnsureCdpReport> {
  const cfg = getConfig();
  const probe = seams.probe ?? probeCdpEndpoint;
  const sleep =
    seams.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const report: EnsureCdpReport = { reachable: false, launched: false, notes: [] };

  if (await probe(cfg.agentCdpUrl)) {
    report.reachable = true;
    return report;
  }
  if (!cfg.cdpAutolaunchEnabled) {
    report.notes.push(
      "CDP Chrome unreachable and CDP_AUTOLAUNCH_ENABLED is off — not launching",
    );
    return report;
  }

  const chrome = findChromeExecutable();
  if (!chrome) {
    report.notes.push(
      "CDP autolaunch: Chrome executable not found (install Chrome or set CHROME_PATH)",
    );
    return report;
  }
  const userDataDir = cdpUserDataDir("jobright");
  const port = new URL(defaultCdpUrl()).port || "9222";
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ];
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    if (seams.spawner) {
      seams.spawner(chrome, args);
    } else {
      const child = spawn(chrome, args, { detached: true, stdio: "ignore" });
      child.unref();
    }
    report.launched = true;
    report.notes.push(`CDP autolaunch: started debug Chrome on port ${port}`);
  } catch (err) {
    report.notes.push(
      `CDP autolaunch: spawn failed: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`,
    );
    return report;
  }

  for (let i = 0; i < READINESS_POLLS; i++) {
    await sleep(POLL_INTERVAL_MS);
    if (await probe(cfg.agentCdpUrl)) {
      report.reachable = true;
      return report;
    }
  }
  report.notes.push(
    `CDP autolaunch: endpoint still unreachable after ${READINESS_POLLS} polls — agent phase will be skipped`,
  );
  return report;
}
