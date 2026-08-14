import path from "node:path";
import { appendJsonl } from "./jsonlEvents.js";
import { getConfig } from "../config/index.js";
import type { TransitionResult } from "../browser/transition.js";

/**
 * Per-transition telemetry for the improvement loop. navSubmitOutcomes
 * records whole navigation and submit ATTEMPTS; the hops INSIDE fill
 * (Apply clicks, wizard steps, portal-auth walks, iframe hops) left no
 * record, so "which host's which transition keeps failing" was
 * unanswerable from artifacts — the exact question host policy answers
 * for the agent. One JSONL line per transition, artifact-pushed with
 * everything else.
 */
export function recordTransitionOutcome(input: {
  seam: string;
  host: string | null;
  result: TransitionResult;
  applicationId?: string | null;
}): void {
  try {
    const cfg = getConfig();
    appendJsonl(path.join(cfg.artifactsDir, "transitions", "transitions.jsonl"), {
      logged_at: new Date().toISOString(),
      seam: input.seam,
      host: input.host,
      application_id: input.applicationId ?? null,
      landed: input.result.landed,
      adopted_popup: input.result.adopted_popup,
      page_class: input.result.classification.page_class,
      field_count: input.result.classification.field_count,
      retried: input.result.retried,
      elapsed_ms: input.result.elapsed_ms,
      url_host: safeHost(input.result.url),
    });
  } catch {
    // Telemetry must never break a flow.
  }
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}
