import type { ApplicationAdapter, DetectionResult } from "./adapter.js";
import { GreenhouseAdapterV1 } from "./greenhouse/v1.js";
import { LeverAdapterV1 } from "./lever/v1.js";
import { AshbyAdapterV1 } from "./ashby/v1.js";
import { WorkableAdapterV1 } from "./workable/v1.js";
import { WorkdayAdapterV1 } from "./workday/v1.js";
import { GenericAdapterV1 } from "./generic/v1.js";
import { UnsupportedAtsAdapter } from "./unsupported.js";

const greenhouse = new GreenhouseAdapterV1();
const lever = new LeverAdapterV1();
const ashby = new AshbyAdapterV1();
const workable = new WorkableAdapterV1();
const workday = new WorkdayAdapterV1();
const generic = new GenericAdapterV1();
const unsupported = new UnsupportedAtsAdapter();

export function listAdapters(): ApplicationAdapter[] {
  return [unsupported, greenhouse, lever, ashby, workable, workday, generic];
}

export async function detectAts(input: {
  url: string;
  html: string;
  title?: string;
}): Promise<{ adapter: ApplicationAdapter; detection: DetectionResult }> {
  // iCIMS/Oracle used to short-circuit to the unsupported adapter here
  // and fill threw. Vendor adapters still win on their own hosts; anything
  // else is generic. UNSUPPORTED_ATS is a URL-transport failure now
  // (non-https / JobRight), decided by detectAtsFromUrl, not this registry.

  const g = await greenhouse.detect(input);
  if (g.matched && g.confidence >= 0.5) {
    return { adapter: greenhouse, detection: g };
  }

  // Lever/Ashby before generic: generic matches any <form> at 0.4.
  const l = await lever.detect(input);
  if (l.matched && l.confidence >= 0.5) {
    return { adapter: lever, detection: l };
  }

  const a = await ashby.detect(input);
  if (a.matched && a.confidence >= 0.5) {
    return { adapter: ashby, detection: a };
  }

  const w = await workable.detect(input);
  if (w.matched && w.confidence >= 0.5) {
    return { adapter: workable, detection: w };
  }

  const wd = await workday.detect(input);
  if (wd.matched && wd.confidence >= 0.5) {
    return { adapter: workday, detection: wd };
  }

  const gen = await generic.detect(input);
  if (gen.matched) {
    return { adapter: generic, detection: gen };
  }

  // No vendor claimed it and the page has no discoverable controls yet
  // (SPA shell, posting chrome). Fill still uses the generic path; the
  // pre-mutation gate names posting/auth/unknown. Never throw a vendor
  // allowlist at this seam — live 2026-08-19 Paylocity Apply page.
  return {
    adapter: generic,
    detection: {
      matched: true,
      confidence: 0.2,
      atsId: "generic",
      evidence: ["no vendor matched — using generic adapter"],
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
