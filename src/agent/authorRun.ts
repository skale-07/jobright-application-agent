import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getConfig, resetConfigCache } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { writeJsonAtomic } from "../storage/atomicJson.js";
import { validateGreenhouseApplicationUrl } from "../ats/greenhouse/urlValidation.js";
import {
  agentAuthoringResultSchema,
  agentAuthoringTaskSchema,
  type AgentAuthoringResult,
  type AgentAuthoringTask,
} from "./contract.js";

/** Phase 6 J1 stays inert unless the operator flips the flag. */
export function assertAgentAuthoringAllowed(): void {
  resetConfigCache();
  const cfg = getConfig();
  if (!cfg.agentAuthoringEnabled) {
    throw new Error(
      "AGENT_AUTHORING_ENABLED=false — refusing agent authoring. This is the Phase 6 J1 sidecar; enable deliberately and see agent/README.md.",
    );
  }
}

export type AuthoringRunReport = {
  run_id: string;
  url: string;
  status: AgentAuthoringResult["status"] | "invalid_output";
  field_candidate_count: number;
  warnings: string[];
  reason: string | null;
  output_path: string | null;
};

/**
 * Spawn the Python sidecar with one task on stdin, validate its stdout with
 * zod, and persist the candidate map under artifacts/ for human review.
 * Promotion into tests/fixtures/ is a separate deliberate step (mirroring
 * recorder:promote) — agent output never lands in committed fixtures
 * directly, and never touches application state at all.
 */
export async function runAgentAuthoring(input: {
  url: string;
  cdpUrl?: string;
  timeoutMs?: number;
  /** Override for tests: command to run instead of python. */
  commandOverride?: { command: string; args: string[] };
}): Promise<AuthoringRunReport> {
  assertAgentAuthoringAllowed();
  const cfg = getConfig();

  const urlValidation = validateGreenhouseApplicationUrl(input.url);
  if (!urlValidation.passed) {
    throw new Error(
      `agent:author currently targets Greenhouse application URLs only: ${urlValidation.failureReason}`,
    );
  }

  const runId = `authoring-${randomUUID()}`;
  const task: AgentAuthoringTask = agentAuthoringTaskSchema.parse({
    task_version: 1,
    url: urlValidation.normalizedUrl ?? input.url,
    cdp_url: input.cdpUrl ?? cfg.agentCdpUrl,
    allowed_domains: ["boards.greenhouse.io", "job-boards.greenhouse.io"],
    timeout_ms: input.timeoutMs ?? 60_000,
  });

  const { command, args } = input.commandOverride ?? {
    command: "python",
    args: ["-m", "jobright_agent.author"],
  };

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: path.join(process.cwd(), "agent"),
      stdio: ["pipe", "pipe", "pipe"],
      timeout: task.timeout_ms + 30_000,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) =>
      reject(new Error(`sidecar spawn failed: ${e.message}`)),
    );
    child.on("close", () => {
      // Non-zero exits still carry a machine-readable result on stdout.
      if (out.trim().length > 0) resolve(out);
      else reject(new Error(`sidecar produced no output. stderr: ${err.slice(0, 400)}`));
    });
    child.stdin.write(JSON.stringify(task));
    child.stdin.end();
  });

  const report: AuthoringRunReport = {
    run_id: runId,
    url: task.url,
    status: "invalid_output",
    field_candidate_count: 0,
    warnings: [],
    reason: null,
    output_path: null,
  };

  let result: AgentAuthoringResult;
  try {
    result = agentAuthoringResultSchema.parse(JSON.parse(stdout.trim()));
  } catch (err) {
    report.reason = `sidecar output failed contract validation: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`;
    return report;
  }

  report.status = result.status;
  report.field_candidate_count = result.field_candidates.length;
  report.warnings = result.warnings;
  report.reason = result.reason ?? null;

  const outDir = path.join(cfg.artifactsDir, "agent-authoring", runId);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "candidate-map.json");
  writeJsonAtomic(outPath, {
    run_id: runId,
    task: { url: task.url, allowed_domains: task.allowed_domains },
    result,
    note: "Human review required. Promote into tests/fixtures/agent-authoring/ deliberately; never wire raw agent output into runtime selectors.",
  });
  report.output_path = outPath;

  logger.info("agent authoring run finished", {
    service: "agent",
    action: "authoring",
    metadata: {
      run_id: runId,
      status: report.status,
      candidates: report.field_candidate_count,
    },
  });
  return report;
}
