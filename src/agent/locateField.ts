import { spawn } from "node:child_process";
import path from "node:path";
import {
  agentAuthoringResultSchema,
  agentLocateFieldTaskSchema,
  type AgentLocateFieldTask,
} from "./contract.js";
import type { FieldCandidate } from "../ats/greenhouse/fillHealer.js";

const HTML_CAP = 500_000;

/**
 * Sidecar escalation for the fill healer (Phase 6a′). Sends the page HTML
 * plus one field description; gets back ranked selector candidates via the
 * zod-authoritative contract. Callers gate on AGENT_FALLBACK_ENABLED —
 * this module only speaks the protocol. The candidates are suggestions:
 * the deterministic retry + read-back verify decide whether any is real.
 */
export async function locateFieldViaSidecar(input: {
  fieldLabel: string;
  fieldType: string;
  html: string;
  timeoutMs?: number;
  /** Override for tests: command to run instead of python. */
  commandOverride?: { command: string; args: string[] };
}): Promise<FieldCandidate[]> {
  const task: AgentLocateFieldTask = agentLocateFieldTaskSchema.parse({
    task_version: 1,
    task_type: "locate_field",
    field_label: input.fieldLabel,
    field_type: input.fieldType,
    html: input.html.slice(0, HTML_CAP),
    timeout_ms: input.timeoutMs ?? 30_000,
  });

  const { command, args } = input.commandOverride ?? {
    command: "python",
    args: ["-m", "jobright_agent.author"],
  };

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: path.join(process.cwd(), "agent"),
      stdio: ["pipe", "pipe", "pipe"],
      timeout: task.timeout_ms + 15_000,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) =>
      reject(new Error(`sidecar spawn failed: ${e.message}`)),
    );
    child.on("close", () => {
      if (out.trim().length > 0) resolve(out);
      else
        reject(
          new Error(`sidecar produced no output. stderr: ${err.slice(0, 300)}`),
        );
    });
    child.stdin.write(JSON.stringify(task));
    child.stdin.end();
  });

  const result = agentAuthoringResultSchema.parse(JSON.parse(stdout.trim()));
  if (result.status !== "ok") {
    throw new Error(`sidecar locate_field error: ${result.reason ?? "unknown"}`);
  }

  return result.field_candidates.flatMap((c) =>
    c.selector_candidates.slice(0, 2).map((selector): FieldCandidate => {
      const idMatch = selector.match(/^#(.+)$/);
      const nameMatch = selector.match(/^\[name="(.+)"\]$/);
      return {
        selector,
        via: "sidecar",
        score: c.confidence,
        ...(idMatch?.[1] ? { inputId: idMatch[1] } : {}),
        ...(nameMatch?.[1] ? { name: nameMatch[1] } : {}),
      };
    }),
  );
}
