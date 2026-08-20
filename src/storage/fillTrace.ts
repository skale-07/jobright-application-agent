import fs from "node:fs";
import path from "node:path";

/**
 * Step-level fill trace artifact (X4) — the fill-side sibling of the nav
 * agent-trace.jsonl, joined to fill_runs via trace_relpath. One JSON line
 * per event; values are CLASSED/IDENTIFIER data only (telemetry PII
 * rule) — the caller must never pass raw candidate values.
 */
export type FillTraceEvent = {
  event:
    | "activation"
    | "extension_satisfied"
    | "native_fill"
    | "verify"
    | "note";
  at: string;
  [key: string]: unknown;
};

const MAX_EVENTS = 500;

export function writeFillTrace(
  outDir: string,
  baseName: string,
  events: FillTraceEvent[],
): string {
  fs.mkdirSync(outDir, { recursive: true });
  const filePath = path.join(outDir, baseName);
  const lines = events
    .slice(0, MAX_EVENTS)
    .map((e) => JSON.stringify(e))
    .join("\n");
  fs.writeFileSync(filePath, `${lines}\n`, "utf8");
  return filePath;
}
