import type { Page } from "playwright";
import { getConfig } from "../config/index.js";
import {
  EXT_SELECTOR_REGISTRY_VERSION,
  jobrightExtensionSelectorsV1,
} from "../jobright/extension/selectors.js";

/**
 * Read-only preflight for the JobRight browser extension in the CDP
 * Chrome. The EXTENSION_FIRST fill strategy requires a "present" verdict;
 * anything less falls back to the native deterministic fill.
 *
 * Honesty rule baked into the type: the verdict is "present" or
 * "unknown" — NEVER a confident "absent". An MV3 extension's service
 * worker is torn down when idle, so a CDP target scan that finds no
 * chrome-extension:// target proves nothing; and the DOM probe can only
 * see open shadow roots, so a missing marker proves nothing either.
 */
export type ExtensionPresence = "present" | "unknown";

export type ExtensionPreflightReport = {
  verdict: ExtensionPresence;
  cdp_reachable: boolean;
  /** chrome-extension:// target titles/urls that matched (evidence). */
  matched_targets: string[];
  registry: string;
  notes: string[];
};

type CdpTarget = { type?: string; url?: string; title?: string };

export type PreflightSeams = {
  /** Test seam: replaces the HTTP GET of the CDP /json target list. */
  fetchTargets?: (cdpUrl: string) => Promise<CdpTarget[]>;
};

async function defaultFetchTargets(cdpUrl: string): Promise<CdpTarget[]> {
  const base = cdpUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/json`, {
    signal: AbortSignal.timeout(3_000),
  });
  if (!res.ok) throw new Error(`CDP /json answered ${res.status}`);
  const body = (await res.json()) as unknown;
  return Array.isArray(body) ? (body as CdpTarget[]) : [];
}

/**
 * Scan the CDP target list for the JobRight extension. Match order:
 * exact id when the operator configured JOBRIGHT_EXTENSION_ID, else any
 * chrome-extension target whose title/url names jobright.
 */
export async function probeCdpTargetsForExtension(
  cdpUrl: string,
  seams: PreflightSeams = {},
): Promise<ExtensionPreflightReport> {
  const cfg = getConfig();
  const report: ExtensionPreflightReport = {
    verdict: "unknown",
    cdp_reachable: false,
    matched_targets: [],
    registry: EXT_SELECTOR_REGISTRY_VERSION,
    notes: [],
  };
  let targets: CdpTarget[];
  try {
    targets = await (seams.fetchTargets ?? defaultFetchTargets)(cdpUrl);
  } catch (err) {
    report.notes.push(
      `CDP target list unreachable (${err instanceof Error ? err.message.slice(0, 120) : String(err)}) — extension presence unknown`,
    );
    return report;
  }
  report.cdp_reachable = true;

  const extTargets = targets.filter((t) =>
    (t.url ?? "").startsWith("chrome-extension://"),
  );
  const wantedId = cfg.jobrightExtensionId?.trim();
  const matched = extTargets.filter((t) => {
    if (wantedId) return (t.url ?? "").includes(wantedId);
    return /jobright/i.test(`${t.title ?? ""} ${t.url ?? ""}`);
  });
  if (matched.length > 0) {
    report.verdict = "present";
    report.matched_targets = matched.map(
      (t) => `${t.type ?? "?"}: ${t.title ?? ""} (${t.url ?? ""})`.slice(0, 200),
    );
    return report;
  }
  report.notes.push(
    extTargets.length > 0
      ? `${extTargets.length} extension target(s) visible, none matched ${wantedId ? `id ${wantedId}` : "/jobright/i"} — presence unknown`
      : "no chrome-extension targets visible — MV3 workers idle out, so this proves nothing (presence unknown)",
  );
  return report;
}

/**
 * Read-only DOM probe on an already-open ATS page: do any of the
 * registry's presence markers exist? Playwright pierces open shadow
 * roots; closed roots / extension iframes stay invisible, so a miss
 * keeps the verdict "unknown".
 */
export async function probeDomForExtension(
  page: Page,
  markers: string[] = jobrightExtensionSelectorsV1.domMarkers,
): Promise<{ verdict: ExtensionPresence; matched_selector: string | null }> {
  for (const sel of markers) {
    const count = await page
      .locator(sel)
      .count()
      .catch(() => 0);
    if (count > 0) return { verdict: "present", matched_selector: sel };
  }
  return { verdict: "unknown", matched_selector: null };
}

/**
 * Combined preflight the fill strategy consults: target scan first
 * (cheap, no page needed), DOM probe only when a page is supplied.
 */
export async function extensionPreflight(input: {
  cdpUrl?: string;
  page?: Page;
  seams?: PreflightSeams;
}): Promise<ExtensionPreflightReport> {
  const cfg = getConfig();
  const report = await probeCdpTargetsForExtension(
    input.cdpUrl ?? cfg.agentCdpUrl,
    input.seams ?? {},
  );
  if (report.verdict === "present" || !input.page) return report;
  const dom = await probeDomForExtension(input.page);
  if (dom.verdict === "present") {
    report.verdict = "present";
    report.matched_targets.push(`dom: ${dom.matched_selector}`);
    report.notes.push("presence confirmed via on-page DOM marker");
  }
  return report;
}
