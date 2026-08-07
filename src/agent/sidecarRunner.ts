import { spawn } from "node:child_process";
import path from "node:path";

/**
 * The one way Node talks to the Python sidecar: spawn, one JSON task on
 * stdin, one JSON result on stdout. Extracted verbatim from the previously
 * duplicated bodies in authorRun.ts and locateField.ts — non-zero exits
 * still carry a machine-readable result on stdout, so they resolve; only
 * empty stdout rejects. Callers own schema validation of the returned raw
 * stdout; this module never parses.
 */
export async function runSidecarTask(input: {
  task: unknown;
  timeoutMs: number;
  /** Extra process-kill grace beyond the task's own timeout. */
  graceMs: number;
  /** Override for tests: command to run instead of python. */
  commandOverride?: { command: string; args: string[] };
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
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
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
