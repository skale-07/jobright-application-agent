import type { Page } from "playwright";
import { performTransition } from "../../browser/transition.js";
import { classifyPage } from "./pageClassify.js";

/**
 * "on the microsoft page it should have easily been able to see, oh im not
 *  on the application page and since i can see clearly theres an apply
 *  button let me click that first" — operator, 2026-08-14.
 *
 * Landing on a posting instead of a form is normal: an Apply click can
 * resolve to the listing page, a deep link can drop on the description, a
 * board can bounce a stale apply URL back to the posting. What was NOT
 * normal is what happened next — the run planned that page as if it were
 * the application, mapped the site's own job-search box to address.country,
 * and spent 100 seconds timing out on it (live: microsoft.eightfold.ai,
 * run aef17b3e).
 *
 * Workday already had this recovery, wired to its own vendor page-kind.
 * Nothing about it is vendor-specific: classify the landing, and if it is
 * a posting, click the Apply control and look again. This is that recovery
 * for every ATS, built on the shared transition primitive so the click gets
 * change-detection, an obstruction-sweep retry, and popup adoption for free.
 *
 * Bounded and honest: at most ADVANCE_CAP hops (a posting that leads to
 * another posting leads nowhere), and if the page is still not a form the
 * caller refuses with the reason named rather than filling the wrong page.
 */

const ADVANCE_CAP = 2;

/**
 * Apply controls in evidence order: explicit apply automation ids first,
 * then accessible-name matches, then a bare link whose text is Apply.
 * Deliberately excludes "Apply filters" / "Apply search" — a listing page's
 * facet controls say Apply too, and clicking one reloads the same listing.
 */
const APPLY_SELECTORS = [
  '[data-automation-id="adventureButton"]',
  '[data-automation-id="applyManually"]',
  'a[href*="apply" i]:not([href*="filter" i])',
  'button[id*="apply" i]',
  '[class*="apply-button" i]',
] as const;

const APPLY_TEXT_RE = /^\s*apply(\s+now|\s+here|\s+for this job)?\s*$/i;

export type PostingAdvanceResult = {
  /** The page the flow should continue on (a popup, if the click opened one). */
  page: Page;
  /** True when the landing is now something other than a posting. */
  advanced: boolean;
  html: string;
  url: string;
  page_class: string;
  hops: number;
  notes: string[];
};

/** Every clickable whose accessible text reads exactly "Apply". */
async function findApplyControl(page: Page) {
  for (const selector of APPLY_SELECTORS) {
    const loc = page.locator(selector).filter({ visible: true }).first();
    if ((await loc.count().catch(() => 0)) > 0) return { loc, how: selector };
  }
  // Text-based last: scan candidates and require the WHOLE label to be
  // Apply-ish, so "Apply filters" and "How to apply" never match.
  const clickables = page.locator("a, button, [role=button]").filter({ visible: true });
  const total = Math.min(await clickables.count().catch(() => 0), 60);
  for (let i = 0; i < total; i++) {
    const candidate = clickables.nth(i);
    const text = (await candidate.textContent().catch(() => "")) ?? "";
    if (APPLY_TEXT_RE.test(text.replace(/\s+/g, " "))) {
      return { loc: candidate, how: `text "${text.trim().slice(0, 20)}"` };
    }
  }
  return null;
}

/**
 * If the current page is a posting, click Apply until it is not (or the cap
 * is hit). Fail-open: any error leaves the page exactly where it was and
 * the caller's existing gate decides what to do.
 */
export async function advancePastPosting(input: {
  page: Page;
  html: string;
  url: string;
  settleTimeoutMs?: number;
}): Promise<PostingAdvanceResult> {
  let page = input.page;
  let html = input.html;
  let url = input.url;
  const notes: string[] = [];
  let hops = 0;

  let classification = classifyPage({ html, url });
  if (classification.page_class !== "posting") {
    return {
      page,
      advanced: false,
      html,
      url,
      page_class: classification.page_class,
      hops: 0,
      notes,
    };
  }

  while (classification.page_class === "posting" && hops < ADVANCE_CAP) {
    const control = await findApplyControl(page).catch(() => null);
    if (!control) {
      notes.push(
        `posting page (${classification.evidence}) but no Apply control found — not filling the posting`,
      );
      break;
    }
    hops += 1;
    notes.push(
      `landed on a posting (${classification.evidence}); clicking Apply via ${control.how}`,
    );
    const transition = await performTransition(page, control.loc, {
      settleTimeoutMs: input.settleTimeoutMs ?? 12_000,
      adoptPopups: true,
      sweepObstructions: true,
    }).catch(() => null);
    if (!transition || !transition.landed) {
      notes.push(
        `Apply click did not change the page${transition ? `: ${transition.notes.join("; ")}` : ""}`,
      );
      break;
    }
    page = transition.page;
    url = transition.url;
    html = transition.html;
    classification = transition.classification;
    notes.push(`Apply landed on: ${classification.page_class} (${classification.evidence})`);
    if (transition.adopted_popup) {
      notes.push("Apply opened a new tab — the flow continues there");
    }
  }

  if (classification.page_class === "posting" && hops >= ADVANCE_CAP) {
    notes.push(
      `still on a posting after ${hops} Apply click(s) — giving up rather than filling the listing page`,
    );
  }

  return {
    page,
    advanced: classification.page_class !== "posting",
    html,
    url,
    page_class: classification.page_class,
    hops,
    notes,
  };
}
