import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import type {
  SubmitConfirmationSummary,
  ConfirmSubmission,
} from "../applications/submitConfirmation.js";

/**
 * The runner ⇄ RunManager stdio protocol. Control frames are single-line
 * JSON objects carrying the reserved top-level key "jaa_frame"; every
 * other stdout/stderr line is an ordinary log line. The report is a frame
 * (never parsed out of logs) and is also persisted to report.json by the
 * runner, so a demux failure can not lose it.
 */

export type RunnerFrame =
  | { jaa_frame: "hello"; kind: string; pid: number; gates: Record<string, boolean> }
  | {
      jaa_frame: "confirm_request";
      confirmation_id: string;
      summary: SubmitConfirmationSummary;
      timeout_ms: number;
    }
  | { jaa_frame: "report"; report: unknown }
  | { jaa_frame: "error"; message: string };

export type ConfirmResponseFrame = {
  jaa_frame: "confirm_response";
  confirmation_id: string;
  accept: boolean;
};

/** Parse one line; null when it is not a control frame (i.e. a log line). */
export function parseFrame(line: string): RunnerFrame | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.includes('"jaa_frame"')) return null;
  try {
    const parsed = JSON.parse(trimmed) as { jaa_frame?: unknown };
    if (typeof parsed.jaa_frame !== "string") return null;
    return parsed as RunnerFrame;
  } catch {
    return null;
  }
}

export function serializeFrame(
  frame: RunnerFrame | ConfirmResponseFrame,
): string {
  return `${JSON.stringify(frame)}\n`;
}

/**
 * Child-side confirmation transport: emit a confirm_request frame on
 * `output`, resolve with the first matching confirm_response line from
 * `input`. Fail closed — timeout, stream end/error, or malformed input
 * all resolve false (decline). Stale/mismatched confirmation ids are
 * ignored until the timeout. The parent runs its own independent
 * auto-decline timer, so a hung child cannot hold a confirmation open.
 */
export function createStdioConfirm(options: {
  input: Readable;
  output: Writable;
  timeoutMs: number;
}): ConfirmSubmission {
  return (summary: SubmitConfirmationSummary) =>
    new Promise<boolean>((resolve) => {
      const confirmationId = randomUUID();
      let buffer = "";
      let settled = false;

      const settle = (accept: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.input.off("data", onData);
        options.input.off("end", onEnd);
        options.input.off("error", onEnd);
        resolve(accept);
      };

      const timer = setTimeout(() => settle(false), options.timeoutMs);

      const onData = (chunk: Buffer | string): void => {
        buffer += chunk.toString();
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          const trimmed = line.trim();
          if (!trimmed) continue;
          let parsed: Partial<ConfirmResponseFrame>;
          try {
            parsed = JSON.parse(trimmed) as Partial<ConfirmResponseFrame>;
          } catch {
            continue; // malformed line — ignore, timeout remains the backstop
          }
          if (parsed.jaa_frame !== "confirm_response") continue;
          if (parsed.confirmation_id !== confirmationId) continue; // stale
          settle(parsed.accept === true);
          return;
        }
      };
      const onEnd = (): void => settle(false);

      options.input.on("data", onData);
      options.input.once("end", onEnd);
      options.input.once("error", onEnd);

      options.output.write(
        serializeFrame({
          jaa_frame: "confirm_request",
          confirmation_id: confirmationId,
          summary,
          timeout_ms: options.timeoutMs,
        }),
      );
    });
}
