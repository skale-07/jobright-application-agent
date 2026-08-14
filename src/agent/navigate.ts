import {
  agentNavigateResultSchema,
  agentNavigateTaskSchema,
  type AgentNavigateResult,
  type AgentNavigateTask,
} from "./contract.js";
import { runSidecarTask } from "./sidecarRunner.js";

/**
 * One navigate turn through the Python sidecar. This module only speaks
 * the protocol — callers gate on NAVIGATION_ENABLED + AGENT_FALLBACK_ENABLED
 * and own the turn loop / Gmail micro-turns. The sidecar's self-report is
 * untrusted: results are zod-validated and a final_url that is
 * non-https, jobright-hosted, or off the task's allowed domains is
 * rejected here regardless of what the agent claimed.
 */
export async function navigateViaSidecar(input: {
  task: AgentNavigateTask;
  commandOverride?: { command: string; args: string[] };
  /** Live sidecar progress (heartbeats + scrubbed step telemetry). */
  onProgress?: (event: Record<string, unknown>) => void;
}): Promise<AgentNavigateResult> {
  const task = agentNavigateTaskSchema.parse(input.task);
  const stdout = await runSidecarTask({
    task,
    timeoutMs: task.timeout_ms,
    graceMs: 30_000,
    ...(input.commandOverride ? { commandOverride: input.commandOverride } : {}),
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
  });
  const result = agentNavigateResultSchema.parse(JSON.parse(stdout.trim()));

  if (result.final_url !== null) {
    const problem = finalUrlProblem(result.final_url, task.allowed_domains);
    if (problem) {
      // A bad final_url is a FAILED TURN, not a crashed phase: the live
      // regression was a stuck-stopped agent whose jobright final_url got
      // THROWN here, skipping turn accounting, notes, and telemetry — six
      // apps died as bare "budget" with the cause invisible. Demote an ok
      // result to an error result; strip the URL from any other status.
      if (result.status === "ok") {
        return {
          ...result,
          status: "error",
          wall: result.wall === "none" ? "budget" : result.wall,
          final_url: null,
          notes: [...result.notes, `final_url rejected: ${problem}`].slice(0, 20),
          reason: `sidecar final_url rejected: ${problem}`,
        };
      }
      return {
        ...result,
        final_url: null,
        notes: [...result.notes, `final_url dropped: ${problem}`].slice(0, 20),
      };
    }
  }
  return result;
}

/** Why this URL cannot be an employer application URL, or null when fine. */
function finalUrlProblem(url: string, allowedDomains: string[]): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "unparseable URL";
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:") {
    return `not https (${parsed.protocol})`;
  }
  if (/(^|\.)jobright\.ai$/i.test(host)) {
    return "jobright-hosted — not an employer URL";
  }
  if (!hostInAllowedDomains(host, allowedDomains)) {
    return `host ${host} is outside allowed domains`;
  }
  return null;
}

/**
 * Vendor domains whose sibling hostnames are the SAME product. Live
 * regression (2026-08-11): the allowlist carried boards.greenhouse.io, the
 * agent landed on job-boards.greenhouse.io — Greenhouse's other board host
 * — and the turn was thrown away as an allowed-domains violation. Sibling
 * matching is confined to this list so it can never widen acceptance to an
 * arbitrary employer's registrable domain, and congruence still runs after.
 */
const ATS_HOST_FAMILIES = [
  "greenhouse.io",
  "lever.co",
  "ashbyhq.com",
  "workable.com",
  "myworkdayjobs.com",
] as const;

function registrableDomain(host: string): string {
  const parts = host.split(".");
  return parts.length >= 2 ? parts.slice(-2).join(".") : host;
}

/** Exact host, subdomain of an allowed entry, or same known-ATS family. */
export function hostInAllowedDomains(
  host: string,
  allowedDomains: string[],
): boolean {
  const h = host.toLowerCase();
  if (
    allowedDomains.some(
      (d) => h === d.toLowerCase() || h.endsWith(`.${d.toLowerCase()}`),
    )
  ) {
    return true;
  }
  const base = registrableDomain(h);
  // A supported ATS host is ALWAYS an acceptable landing place, whether or
  // not the JobRight page happened to link that vendor. Requiring the
  // family to already be in allowedDomains threw away agent turns that had
  // reached a real application form — "the page didn't link lever.co" is
  // not evidence that a lever.co form is the wrong form.
  //
  // This widens where the agent may LAND, never what gets stored: the
  // resolved URL still has to pass its adapter's URL validation and the
  // congruence check against the job's company, so another employer's
  // Greenhouse board is still refused as a mismatch.
  return ATS_HOST_FAMILIES.includes(
    base as (typeof ATS_HOST_FAMILIES)[number],
  );
}
