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
}): Promise<AgentNavigateResult> {
  const task = agentNavigateTaskSchema.parse(input.task);
  const stdout = await runSidecarTask({
    task,
    timeoutMs: task.timeout_ms,
    graceMs: 30_000,
    ...(input.commandOverride ? { commandOverride: input.commandOverride } : {}),
  });
  const result = agentNavigateResultSchema.parse(JSON.parse(stdout.trim()));

  if (result.final_url !== null) {
    let parsed: URL;
    try {
      parsed = new URL(result.final_url);
    } catch {
      throw new Error(`sidecar returned an unparseable final_url`);
    }
    const host = parsed.hostname.toLowerCase();
    const allowed = task.allowed_domains.some(
      (d) => host === d.toLowerCase() || host.endsWith(`.${d.toLowerCase()}`),
    );
    if (parsed.protocol !== "https:") {
      throw new Error(`sidecar final_url is not https (${parsed.protocol})`);
    }
    if (/(^|\.)jobright\.ai$/i.test(host)) {
      throw new Error("sidecar final_url is jobright-hosted — not an employer URL");
    }
    if (!allowed) {
      throw new Error(`sidecar final_url host ${host} is outside allowed domains`);
    }
  }
  return result;
}
