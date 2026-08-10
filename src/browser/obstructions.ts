import type { Page } from "playwright";

/**
 * Popup/interstitial dismisser — cookie banners, newsletter modals,
 * JobRight upsell dialogs: overlays that are NOT part of the application
 * and block the controls under them. Selectors live here (registry rule),
 * not in flow code.
 *
 * Safety posture:
 *   - Callers are already inside mutation-gated flows (NAVIGATION_ENABLED
 *     click phase, FORM_FILL execute paths) — this helper must never be
 *     called from a read-only/plan-only path.
 *   - Only elements INSIDE an overlay-ish container are ever clicked, and
 *     only when their accessible name matches an explicitly dismissive
 *     pattern. Anything that could progress, submit, agree to more than
 *     cookies, or spend (`neverClickPattern`) is refused even inside a
 *     dialog — a modal that only offers "Submit application" is left alone.
 *   - Hard caps: at most `maxDismissals` clicks, bounded settle waits.
 */
export const obstructionSelectorsV1 = {
  /** Overlay-ish containers worth inspecting. */
  containers:
    "[role='dialog'], [aria-modal='true'], [class*='modal' i], [id*='cookie' i], [class*='cookie' i], [id*='consent' i], [class*='consent' i], [class*='popup' i], [id*='onetrust' i]",
  /** Accessible names that mean "make this go away". */
  dismissNamePattern:
    /^(accept( all)?( cookies)?|got it|ok(ay)?|close|dismiss|no,? thanks?|maybe later|not now|skip( for now)?|reject( all)?|decline|i (understand|agree)|allow all|later|✕|×|x)$/i,
  /** Close affordances that carry no text (X buttons). */
  closeControls:
    "button[aria-label*='close' i], button[aria-label*='dismiss' i], [role='button'][aria-label*='close' i]",
  /**
   * NEVER clicked, even inside a dialog — progression, submission,
   * account, or spend semantics. The application itself might live in a
   * modal on some sites; these words are how we never touch it.
   */
  neverClickPattern:
    /submit|apply|continue|next|save|send|sign|log ?in|create|delete|remove|unsubscribe|buy|upgrade|pay|start|finish|confirm/i,
  status: "UNVERIFIED_SELECTOR" as const,
} as const;

export type ObstructionDismissResult = {
  dismissed: string[];
  notes: string[];
};

/**
 * Best-effort, bounded dismissal of overlays on the current page. Returns
 * what was clicked (short labels) — telemetry for the caller's notes. A
 * page with no obstructions returns fast; failures never throw.
 */
export async function dismissPageObstructions(
  page: Page,
  options: { maxDismissals?: number; settleMs?: number } = {},
): Promise<ObstructionDismissResult> {
  const sel = obstructionSelectorsV1;
  const maxDismissals = options.maxDismissals ?? 3;
  const settleMs = options.settleMs ?? 400;
  const dismissed: string[] = [];
  const notes: string[] = [];

  try {
    for (let round = 0; round < maxDismissals; round++) {
      const containers = await page.locator(sel.containers).all();
      let clickedThisRound = false;
      for (const container of containers) {
        if (dismissed.length >= maxDismissals) break;
        if (!(await container.isVisible().catch(() => false))) continue;

        // Preferred: an explicit close affordance inside the container.
        let target = container.locator(sel.closeControls).first();
        let label = "close (aria-label)";
        if ((await target.count().catch(() => 0)) === 0) {
          // Else: a button/link whose whole name is dismissive.
          const candidates = await container
            .locator("button, [role='button'], a")
            .all()
            .catch(() => []);
          let found = null;
          for (const c of candidates.slice(0, 12)) {
            const name = (
              ((await c.textContent().catch(() => null)) ?? "") ||
              ((await c.getAttribute("aria-label").catch(() => null)) ?? "")
            ).trim();
            if (!name || name.length > 40) continue;
            if (sel.neverClickPattern.test(name)) continue;
            if (!sel.dismissNamePattern.test(name)) continue;
            found = c;
            label = name.slice(0, 30);
            break;
          }
          if (!found) continue;
          target = found;
        } else {
          // aria-close buttons still get the never-click screen on their label
          const aria =
            ((await target.getAttribute("aria-label").catch(() => null)) ?? "").trim();
          if (aria && sel.neverClickPattern.test(aria)) continue;
        }

        await target.click({ timeout: 2_000 }).catch(() => {
          notes.push(`dismiss click failed: ${label}`);
        });
        dismissed.push(label);
        clickedThisRound = true;
        await page.waitForTimeout(settleMs);
      }
      if (!clickedThisRound) break; // nothing left that qualifies
    }
  } catch (err) {
    notes.push(
      `obstruction scan error: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`,
    );
  }
  return { dismissed, notes };
}
