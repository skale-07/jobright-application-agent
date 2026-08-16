/**
 * Loopback-only trace from ats:fill → the employer sandbox terminal.
 * No-op against any non-local URL. Fail-open: a down sandbox must never
 * break a fill. LLM request/response dumps are also written under
 * artifacts/sandbox/ so they survive a stale sandbox process.
 */

import fs from "node:fs";
import path from "node:path";

export type SandboxTraceEvent = {
  kind: string;
  lines: string[];
};

export function llmTraceEvent(input: {
  surface: string;
  system: string;
  user: unknown;
  response: string;
}): SandboxTraceEvent {
  const userPretty =
    typeof input.user === "string"
      ? input.user
      : JSON.stringify(input.user, null, 2);
  return {
    kind: `llm ${input.surface}`,
    lines: [
      "— request.system —",
      ...input.system.split("\n"),
      "— request.user —",
      ...userPretty.split("\n"),
      "— response —",
      ...input.response.split("\n"),
    ],
  };
}

export function sandboxOriginFromUrl(targetUrl: string): string | null {
  try {
    const u = new URL(targetUrl);
    if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

export async function postSandboxTrace(
  targetUrl: string,
  event: SandboxTraceEvent,
): Promise<void> {
  const origin = sandboxOriginFromUrl(targetUrl);
  if (!origin || event.lines.length === 0) return;
  try {
    const dir = path.join(process.cwd(), "artifacts", "sandbox");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = Date.now();
    const slug = event.kind.replace(/\s+/g, "-").replace(/[^a-z0-9-]/gi, "");
    fs.writeFileSync(
      path.join(dir, `${slug}-${stamp}.json`),
      JSON.stringify(event, null, 2),
      "utf8",
    );
  } catch {
    // artifact write is best-effort
  }
  try {
    await fetch(`${origin}/trace`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
  } catch {
    // sandbox not running, or this URL is not the rig
  }
}
