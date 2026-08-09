/**
 * Deterministic-first host policy for the navigation agent (phase C).
 * The telemetry corpus (navigation_attempts) is the memory: once a host
 * has burned the agent budget repeatedly with nothing resolved, stop
 * paying the agent tax there and park immediately — the review queue is
 * cheaper than a fourth doomed 25-step agent run. This is the first
 * "learned" policy in the codebase and it is deliberately NOT a model:
 * a threshold over recorded outcomes, capped, auditable, and fail-open
 * (no telemetry ⇒ run the agent).
 */
import type { Db } from "../storage/db/client.js";
import { logger } from "../logging/logger.js";

export type AgentHostPolicy = {
  runAgent: boolean;
  reason: string;
  prior_agent_attempts: number;
  prior_resolved: number;
};

export const HOST_POLICY_MIN_ATTEMPTS = 3;

export function evaluateAgentHostPolicy(
  db: Db,
  host: string | null,
  opts: { minAttempts?: number } = {},
): AgentHostPolicy {
  const minAttempts = opts.minAttempts ?? HOST_POLICY_MIN_ATTEMPTS;
  const open: AgentHostPolicy = {
    runAgent: true,
    reason: "no prior evidence against this host",
    prior_agent_attempts: 0,
    prior_resolved: 0,
  };
  if (!host) return open;
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS attempts, SUM(resolved) AS resolved
         FROM navigation_attempts
         WHERE start_host = ? AND agent_turns IS NOT NULL`,
      )
      .get(host) as { attempts: number; resolved: number | null };
    const attempts = row.attempts;
    const resolved = row.resolved ?? 0;
    if (resolved > 0) {
      return {
        runAgent: true,
        reason: `agent has resolved this host before (${resolved}/${attempts})`,
        prior_agent_attempts: attempts,
        prior_resolved: resolved,
      };
    }
    if (attempts >= minAttempts) {
      return {
        runAgent: false,
        reason: `host policy: ${attempts} prior agent attempts on ${host}, 0 resolved — deterministic-first, parking for review`,
        prior_agent_attempts: attempts,
        prior_resolved: 0,
      };
    }
    return {
      runAgent: true,
      reason: `${attempts}/${minAttempts} unresolved attempts — agent still worth trying`,
      prior_agent_attempts: attempts,
      prior_resolved: 0,
    };
  } catch (err) {
    // Fail open: a telemetry problem must never withhold the agent.
    logger.warn("host policy evaluation failed (fail-open: run agent)", {
      service: "navigation",
      action: "host_policy_error",
      metadata: {
        host,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return open;
  }
}
