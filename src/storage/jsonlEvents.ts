import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config/index.js";

export function appendJsonl(filePath: string, record: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

/** Optional diagnostic mirror — not source of truth. */
export function appendApplicationDiagnosticEvent(
  record: Record<string, unknown>,
): void {
  appendJsonl(getConfig().jsonlEventsPath, {
    ...record,
    logged_at: new Date().toISOString(),
  });
}
