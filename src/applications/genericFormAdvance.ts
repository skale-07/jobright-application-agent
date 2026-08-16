import type { Page } from "playwright";
import { performTransition } from "../browser/transition.js";
import { discoverFieldsFromHtml } from "./fieldDiscovery.js";
import { genericSelectorsV1 } from "../ats/generic/selectors.js";
import {
  resolveAdvanceControl,
  resolveSubmitControl,
} from "../ats/shared/submitControl.js";
import { classifyPage } from "../ats/shared/pageClassify.js";

/**
 * Generic multi-page forms (Paycom lead-capture "Continue to application",
 * iframe wizards whose Next is type=button). Workday has its own walker;
 * this is the same idea for the generic adapter.
 *
 * After the landing page is filled, if the only CTA is Next/Continue (the
 * submit cascade correctly refuses those names), click it, re-plan, fill.
 * NEVER clicks a control `resolveSubmitControl` would accept — `--submit`
 * owns that. Bounded. Stops on unchanged page, confirmation, or empty form.
 */

export type GenericAdvancePageResult = {
  page: number;
  url: string;
  kind: string;
  fillable: number;
  filled: number;
  verify_passed: boolean;
};

export type GenericAdvanceWalkResult = {
  /** The page the flow should continue on (a popup, if Continue opened one). */
  page: Page;
  pages: GenericAdvancePageResult[];
  verifyFailed: boolean;
  notes: string[];
};

/** Extra pages beyond the landing page. */
export const GENERIC_ADVANCE_PAGE_CAP = 3;

export async function walkGenericFormPages(
  page: Page,
  fillCurrentPage: (input: {
    page: Page;
    html: string;
    url: string;
  }) => Promise<{ fillable: number; filled: number; verifyPassed: boolean }>,
  options: { settleMs?: number } = {},
): Promise<GenericAdvanceWalkResult> {
  const notes: string[] = [];
  const pages: GenericAdvancePageResult[] = [];
  let verifyFailed = false;
  let current = page;
  const settleTimeoutMs =
    options.settleMs === 0 ? 0 : (options.settleMs ?? 10_000);

  for (let extra = 1; extra <= GENERIC_ADVANCE_PAGE_CAP; extra++) {
    const submit = await resolveSubmitControl(
      current,
      genericSelectorsV1.submitCascade,
    );
    if (submit.found) {
      notes.push(
        `form-advance: visible submit after page ${extra} — leaving it for the gated submit path`,
      );
      break;
    }

    const advance = await resolveAdvanceControl(
      current,
      genericSelectorsV1.submitCascade,
    );
    if (!advance.found) {
      notes.push(
        `form-advance: no Next/Continue after page ${extra} — stopping`,
      );
      break;
    }

    const transition = await performTransition(current, advance.control, {
      settleTimeoutMs,
      sweepObstructions: true,
    });
    notes.push(...advance.notes);
    notes.push(...transition.notes.map((n) => `form-advance: ${n}`));
    if (!transition.landed) {
      notes.push(
        `form-advance: page unchanged after Continue/Next on page ${extra} — stopping`,
      );
      break;
    }
    current = transition.page;
    if (transition.adopted_popup) {
      notes.push(
        "form-advance: click opened a tab — continuing on the adopted page",
      );
    }

    const html = transition.html;
    const classification = classifyPage({
      html,
      url: current.url(),
    });
    if (classification.page_class === "confirmation") {
      notes.push(
        "form-advance: landed on a confirmation — no further pages to fill",
      );
      break;
    }
    if (discoverFieldsFromHtml(html).length === 0) {
      notes.push(
        `form-advance: page ${extra + 1} has no fillable fields — stopping`,
      );
      break;
    }

    const result = await fillCurrentPage({
      page: current,
      html,
      url: current.url(),
    });
    pages.push({
      page: extra + 1,
      url: current.url(),
      kind: classification.page_class,
      fillable: result.fillable,
      filled: result.filled,
      verify_passed: result.verifyPassed,
    });
    if (!result.verifyPassed) {
      verifyFailed = true;
      notes.push(
        `form-advance: verify failed on page ${extra + 1} — not advancing further`,
      );
      break;
    }
  }

  if (pages.length > 0) {
    notes.push(
      `form-advance: filled ${pages.length} additional page(s) — ${pages
        .map((p) => `${p.kind}:${p.filled}/${p.fillable}`)
        .join(", ")}`,
    );
  }
  return { page: current, pages, verifyFailed, notes };
}
