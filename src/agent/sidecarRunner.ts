import { spawn } from "node:child_process";
import path from "node:path";

/**
 * The one way Node talks to the Python sidecar: spawn, one JSON task on
 * stdin, one JSON result on stdout. Extracted verbatim from the previously
 * duplicated bodies in authorRun.ts and locateField.ts — non-zero exits
 * still carry a machine-readable result on stdout, so they resolve; only
 * empty stdout rejects. Callers own schema validation of the returned raw
 * stdout; this module never parses the RESULT.
 *
 * Progress stream (observability + training capture): the sidecar may
 * write NDJSON lines to STDERR shaped {"jaa_progress":1, ...}. Those are
 * surfaced live through onProgress as they arrive — stdout's one-JSON
 * result contract is untouched, so a sidecar that never emits progress
 * (or an old one) behaves exactly as before. Progress is telemetry, never
 * a contract result: a caller must not treat any progress line as the
 * outcome. Capped at 500 lines per run so a thrashing agent can't melt
 * the log store.
 */
const PROGRESS_LINE_CAP = 500;

export async function runSidecarTask(input: {
  task: unknown;
  timeoutMs: number;
  /** Extra process-kill grace beyond the task's own timeout. */
  graceMs: number;
  /** Override for tests: command to run instead of python. */
  commandOverride?: { command: string; args: string[] };
  /** Live progress sink for {"jaa_progress":1,...} stderr lines. */
  onProgress?: (event: Record<string, unknown>) => void;
}): Promise<string> {
  const { command, args } = input.commandOverride ?? {
    command: "python",
    args: ["-m", "jobright_agent.author"],
  };

  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: path.join(process.cwd(), "agent"),
      stdio: ["pipe", "pipe", "pipe"],
      timeout: input.timeoutMs + input.graceMs,
    });
    let out = "";
    let err = "";
    let errLineBuf = "";
    let progressSeen = 0;
    const handleErrChunk = (chunk: string): void => {
      err += chunk;
      if (!input.onProgress) return;
      errLineBuf += chunk;
      let nl: number;
      while ((nl = errLineBuf.indexOf("\n")) >= 0) {
        const line = errLineBuf.slice(0, nl).trim();
        errLineBuf = errLineBuf.slice(nl + 1);
        if (!line.startsWith('{"jaa_progress"')) continue;
        if (progressSeen >= PROGRESS_LINE_CAP) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed["jaa_progress"] === 1) {
            progressSeen += 1;
            input.onProgress(parsed);
          }
        } catch {
          // malformed progress is ignored — stderr is untrusted output
        }
      }
    };
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => handleErrChunk(d.toString()));
    child.on("error", (e) =>
      reject(new Error(`sidecar spawn failed: ${e.message}`)),
    );
    child.on("close", () => {
      // Non-zero exits still carry a machine-readable result on stdout.
      if (out.trim().length > 0) resolve(out);
      else
        reject(
          new Error(`sidecar produced no output. stderr: ${err.slice(0, 400)}`),
        );
    });
    child.stdin.write(JSON.stringify(input.task));
    child.stdin.end();
  });
}
