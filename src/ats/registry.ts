import type { ApplicationAdapter, DetectionResult } from "./adapter.js";
import { GreenhouseAdapterV1 } from "./greenhouse/v1.js";
import { GenericAdapterV1 } from "./generic.js";
import { UnsupportedAtsAdapter } from "./unsupported.js";

const greenhouse = new GreenhouseAdapterV1();
const generic = new GenericAdapterV1();
const unsupported = new UnsupportedAtsAdapter();

export function listAdapters(): ApplicationAdapter[] {
  return [unsupported, greenhouse, generic];
}

export async function detectAts(input: {
  url: string;
  html: string;
  title?: string;
}): Promise<{ adapter: ApplicationAdapter; detection: DetectionResult }> {
  // Prefer explicit unsupported (Workday etc.) over generic
  const u = await unsupported.detect(input);
  if (u.matched) {
    return { adapter: unsupported, detection: u };
  }

  const g = await greenhouse.detect(input);
  if (g.matched && g.confidence >= 0.5) {
    return { adapter: greenhouse, detection: g };
  }

  const gen = await generic.detect(input);
  if (gen.matched) {
    return { adapter: generic, detection: gen };
  }

  return {
    adapter: unsupported,
    detection: {
      matched: true,
      confidence: 0.2,
      atsId: "unknown",
      evidence: ["no adapter matched confidently"],
    },
  };
}

export async function resolveAdapterForUrl(
  url: string,
  html: string,
): Promise<ApplicationAdapter> {
  const { adapter } = await detectAts({ url, html });
  return adapter;
}
