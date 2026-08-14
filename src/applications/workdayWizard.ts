import type { Page } from "playwright";
import { workdaySelectorsV1 } from "../ats/workday/selectors.js";
import { classifyWorkdayPage } from "../ats/workday/pageKind.js";
import { discoverFieldsFromHtml } from "./fieldDiscovery.js";
import { scanRequiredCompleteness } from "../ats/shared/requiredCompleteness.js";
import { performTransition } from "../browser/transition.js";
import { recordTransitionOutcome } from "../storage/transitionOutcomes.js";

/**
 * Workday multi-page wizard walk (Crowe live 2026-08-14: a 7-step wizard
 * got only its landing page filled; every later page's required questions
 * were never even seen, so submit refused on "unanswered questions").
 *
 * The walk clicks Next through the shared transition primitive (bounded
 * change-detection, obstruction retry, popup adoption) and hands each new
 * page to the caller's filler. It NEVER clicks the submit button — the
 * gated submit path owns that click.
 *
 * Two diagnoses replace silent stops:
 *   - Next DISABLED → the required-completeness scan names the exact
 *     fields blocking it ("blocked by: Phone Device Type, Country").
 *   - Landing on an auth wall mid-walk (session expired between pages) →
 *     the caller's onAuthWall seam may sign back in ONCE; the walk then
 *     resumes instead of stopping.
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
  options: {
    settleMs?: number;
    /**
     * Mid-walk auth recovery (used at most once): return true when the
     * wall was cleared and the walk may resume. Absent ⇒ auth stops the
     * walk, as before.
     */
    onAuthWall?: (page: Page) => Promise<boolean>;
    applicationId?: string | null;
  } = {},
): Promise<WizardWalkResult> {
  const notes: string[] = [];
  const pages: WizardPageResult[] = [];
  let verifyFailed = false;
  let authRecoveryUsed = false;
  const settleTimeoutMs = options.settleMs === 0 ? 0 : (options.settleMs ?? 10_000);

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

    // Workday DISABLES Next while required fields are empty. Clicking a
    // disabled button "fails" as an unchanged page — diagnose it up front
    // and name the blockers instead.
    const nextDisabled =
      (await next.isDisabled().catch(() => false)) ||
      (await next.getAttribute("aria-disabled").catch(() => null)) === "true";
    if (nextDisabled) {
      const scan = await scanRequiredCompleteness(page).catch(() => null);
      const blockers =
        scan?.unanswered.map((u) => u.label).filter(Boolean).slice(0, 8) ?? [];
      notes.push(
        blockers.length > 0
          ? `wizard: Next disabled on page ${extra} — blocked by: ${blockers.join(", ")}`
          : `wizard: Next disabled on page ${extra} — no unanswered required fields found (control-level block)`,
      );
      verifyFailed = true;
      break;
    }

    const transition = await performTransition(page, next, {
      settleTimeoutMs,
      readyMarker: workdaySelectorsV1.formMarkers,
      // The caller is already inside the fill mutation gate.
      sweepObstructions: true,
    });
    notes.push(...transition.notes.map((n) => `wizard: ${n}`));
    recordTransitionOutcome({
      seam: "workday_wizard_next",
      host: safeHost(page.url()),
      result: transition,
      applicationId: options.applicationId ?? null,
    });
    if (transition.adopted_popup) {
      // Workday never legitimately continues its wizard in a new tab.
      notes.push("wizard: click opened a tab — not a wizard page, stopping the walk");
      break;
    }
    if (!transition.landed) {
      notes.push(`wizard: page unchanged after Next on page ${extra} — stopping the walk`);
      break;
    }

    let html = transition.html;
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

    let kind = classifyWorkdayPage(html);
    if (kind === "auth") {
      // Session expired between pages. One recovery, then resume.
      if (options.onAuthWall && !authRecoveryUsed) {
        authRecoveryUsed = true;
        notes.push("wizard: auth wall mid-walk — attempting portal sign-in");
        const cleared = await options.onAuthWall(page).catch(() => false);
        if (!cleared) {
          notes.push("wizard: auth wall not cleared — stopping the walk");
          verifyFailed = true;
          break;
        }
        html = await page.content().catch(() => "");
        kind = classifyWorkdayPage(html);
        notes.push(`wizard: signed back in — page kind now ${kind}`);
        if (kind === "auth") {
          verifyFailed = true;
          break;
        }
      } else {
        notes.push("wizard: auth wall mid-walk — stopping the walk");
        verifyFailed = true;
        break;
      }
    }

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

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}
