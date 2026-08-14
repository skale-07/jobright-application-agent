import type { Page } from "playwright";
import { workdaySelectorsV1 } from "../ats/workday/selectors.js";
import { classifyWorkdayPage } from "../ats/workday/pageKind.js";
import { discoverFieldsFromHtml } from "./fieldDiscovery.js";

/**
 * Workday multi-page wizard walk (Crowe live 2026-08-14: a 7-step wizard
 * got only its landing page filled; every later page's required questions
 * were never even seen, so submit refused on "unanswered questions").
 *
 * The walk clicks Next → settles → hands the new page to the caller's
 * filler → repeats, bounded. It NEVER clicks the submit button — the
 * gated submit path owns that click — and stops on Workday's own error
 * banner (missing required fields park for review; nothing is forced).
 */
export type WizardPageResult = {
  page: number;
  url: string;
  kind: string;
  fillable: number;
  filled: number;
  verify_passed: boolean;
};

export type WizardWalkResult = {
  pages: WizardPageResult[];
  /** True when any walked page failed its verify (demotes the run level). */
  verifyFailed: boolean;
  notes: string[];
};

const NEXT_NAME_RE = /^(next|save and continue|continue)$/i;
/** Additional pages beyond the landing page — hard cap, never unbounded. */
export const WIZARD_PAGE_CAP = 5;

export async function walkWorkdayWizard(
  page: Page,
  fillCurrentPage: (input: {
    html: string;
    url: string;
  }) => Promise<{ fillable: number; filled: number; verifyPassed: boolean }>,
  options: { settleMs?: number } = {},
): Promise<WizardWalkResult> {
  const notes: string[] = [];
  const pages: WizardPageResult[] = [];
  let verifyFailed = false;
  const settleMs = options.settleMs ?? 2_000;

  for (let extra = 1; extra <= WIZARD_PAGE_CAP; extra++) {
    const bySelector = page.locator(workdaySelectorsV1.wizard.nextButton).first();
    const next =
      (await bySelector.count().catch(() => 0)) > 0 &&
      (await bySelector.isVisible().catch(() => false))
        ? bySelector
        : page.getByRole("button", { name: NEXT_NAME_RE }).first();
    if (
      (await next.count().catch(() => 0)) === 0 ||
      !(await next.isVisible().catch(() => false))
    ) {
      notes.push(`wizard: no Next control after page ${extra} — review/summary reached`);
      break;
    }
    // Snapshot BEFORE the click so the settle below can verify the page
    // actually changed — a sleep alone races the SPA's re-render (the
    // walk once snapshotted the pre-click page and handed a stale form to
    // the filler while the live DOM had already moved on).
    const preClickHtml = await page.content().catch(() => "");
    await next.click({ timeout: 10_000 }).catch((e: Error) => {
      notes.push(`wizard: Next click failed: ${e.message.slice(0, 100)}`);
    });
    await page
      .waitForLoadState("domcontentloaded", { timeout: 15_000 })
      .catch(() => undefined);
    if (settleMs > 0) await page.waitForTimeout(settleMs);

    let html = await page.content().catch(() => "");
    // Bounded change-detection: up to 10s for the wizard page to differ
    // from its pre-click DOM. An unchanged page after that is itself a
    // signal (Next did nothing) — noted, walk ends.
    for (let poll = 0; poll < 50 && html === preClickHtml; poll++) {
      await page.waitForTimeout(200);
      html = await page.content().catch(() => "");
    }
    if (html === preClickHtml) {
      notes.push(`wizard: page unchanged after Next on page ${extra} — stopping the walk`);
      break;
    }
    if (
      /data-automation-id=["']errorBanner|please fix the errors|required information is missing/i.test(
        html,
      )
    ) {
      notes.push(
        `wizard: Workday flagged errors on page ${extra} — stopping the walk (fields park for review)`,
      );
      verifyFailed = true;
      break;
    }
    const kind = classifyWorkdayPage(html);
    if (discoverFieldsFromHtml(html).length === 0) {
      notes.push(`wizard page ${extra + 1} (${kind}): no fillable fields — stopping the walk`);
      break;
    }
    const result = await fillCurrentPage({ html, url: page.url() });
    pages.push({
      page: extra + 1,
      url: page.url(),
      kind,
      fillable: result.fillable,
      filled: result.filled,
      verify_passed: result.verifyPassed,
    });
    if (!result.verifyPassed) verifyFailed = true;
  }
  if (pages.length > 0) {
    notes.push(
      `wizard: filled ${pages.length} additional page(s) — ${pages
        .map((p) => `${p.kind}:${p.filled}/${p.fillable}`)
        .join(", ")}`,
    );
  }
  return { pages, verifyFailed, notes };
}
