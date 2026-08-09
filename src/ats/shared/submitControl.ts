import type { Locator, Page } from "playwright";

/**
 * Ranked, form-scoped submit-control resolution shared by the ATS adapters.
 *
 * Why this exists: the first live Ashby submit attempt died on a naïve
 * `button[type='submit']` one-shot query — live Ashby renders a custom React
 * footer whose CTA is often `type="button"` with the text "Submit
 * application", and it may not be mounted at first query. The cascade
 * resolves by accessible name first (scoped to the application form), then
 * by CSS, waits briefly for visibility, and explicitly refuses wizard
 * controls (Next/Continue/…) — clicking the wrong button is worse than not
 * clicking at all.
 *
 * On a miss it returns an inventory of every CTA-looking control so the
 * failure lands in the submit report as evidence, not a black box.
 */

export type SubmitCascadeConfig = {
  /** Scope: the application form. Falls back to page scope when absent. */
  form: string;
  /** ATS-specific CSS tier (comma list, most specific first). */
  css: string;
  /** Accessible-name tier: what a submit CTA is called. */
  namePattern: RegExp;
  /** Names that are NEVER the submit control (wizard/nav/consent buttons). */
  excludePattern: RegExp;
};

export type CtaInventoryEntry = {
  tag: string;
  type: string | null;
  text: string;
  aria_label: string | null;
  disabled: boolean;
  visible: boolean;
};

export type SubmitControlResolution =
  | { found: true; control: Locator; via: string; notes: string[] }
  | { found: false; notes: string[]; inventory: CtaInventoryEntry[] };

const CANDIDATE_CAP = 10;
const VISIBLE_WAIT_MS = 3_000;

async function accessibleText(loc: Locator): Promise<string> {
  const aria = await loc.getAttribute("aria-label").catch(() => null);
  if (aria && aria.trim()) return aria.trim();
  const text = await loc.innerText().catch(() => "");
  if (text.trim()) return text.replace(/\s+/g, " ").trim();
  const value = await loc.getAttribute("value").catch(() => null);
  return (value ?? "").trim();
}

/**
 * Every control that could plausibly be a CTA, for failure evidence.
 * Bounded and text-truncated — this goes verbatim into report notes.
 */
export async function inventorySubmitCandidates(
  page: Page,
  formSelector: string,
): Promise<CtaInventoryEntry[]> {
  const form = page.locator(formSelector).first();
  const root = (await form.count().catch(() => 0)) > 0 ? form : page.locator("body");
  const candidates = root.locator(
    "button, input[type='submit'], input[type='button'], [role='button']",
  );
  const n = Math.min(await candidates.count().catch(() => 0), 25);
  const out: CtaInventoryEntry[] = [];
  for (let i = 0; i < n; i++) {
    const c = candidates.nth(i);
    out.push({
      tag: await c
        .evaluate((el: { tagName: string }) => el.tagName.toLowerCase())
        .catch(() => "?"),
      type: await c.getAttribute("type").catch(() => null),
      text: (await accessibleText(c)).slice(0, 80),
      aria_label: await c.getAttribute("aria-label").catch(() => null),
      disabled: await c.isDisabled().catch(() => false),
      visible: await c.isVisible().catch(() => false),
    });
  }
  return out;
}

/**
 * Resolve the submit control through the ranked cascade. The returned
 * control may still be disabled — callers keep their own disabled handling
 * (a disabled Submit is a distinct signal, e.g. a verification wall).
 */
export async function resolveSubmitControl(
  page: Page,
  cfg: SubmitCascadeConfig,
): Promise<SubmitControlResolution> {
  const notes: string[] = [];
  const form = page.locator(cfg.form).first();
  const formPresent = (await form.count().catch(() => 0)) > 0;
  if (!formPresent) notes.push("no form scope — resolving page-wide");
  const root = formPresent ? form : page.locator("body");

  const tiers: Array<{ via: string; loc: Locator }> = [
    // Accessible name first: survives type="button" React footers.
    { via: "role-name", loc: root.getByRole("button", { name: cfg.namePattern }) },
    { via: "css", loc: root.locator(cfg.css) },
  ];
  if (formPresent) {
    // Custom footers can render the CTA OUTSIDE the <form>. Page-wide
    // fallback is name-tier only — a page-wide CSS sweep could hit an
    // unrelated form's submit, but a control literally named "Submit
    // application" is what we're looking for wherever it mounts.
    tiers.push({
      via: "page-role-name",
      loc: page.getByRole("button", { name: cfg.namePattern }),
    });
  }

  for (const tier of tiers) {
    const n = Math.min(await tier.loc.count().catch(() => 0), CANDIDATE_CAP);
    for (let i = 0; i < n; i++) {
      const candidate = tier.loc.nth(i);
      const text = await accessibleText(candidate);
      if (text && cfg.excludePattern.test(text)) {
        notes.push(`skipped ${tier.via} candidate "${text.slice(0, 40)}" (excluded name)`);
        continue;
      }
      // The CSS tier can hit controls with no submit-ish name at all (an
      // unnamed icon button). Accept those only when the name tier found
      // nothing — which is exactly this loop order.
      await candidate.scrollIntoViewIfNeeded().catch(() => undefined);
      try {
        await candidate.waitFor({ state: "visible", timeout: VISIBLE_WAIT_MS });
      } catch {
        notes.push(
          `${tier.via} candidate "${text.slice(0, 40)}" never became visible`,
        );
        continue;
      }
      notes.push(`resolved via ${tier.via}: "${text.slice(0, 40)}"`);
      return { found: true, control: candidate, via: tier.via, notes };
    }
  }

  const inventory = await inventorySubmitCandidates(page, cfg.form).catch(
    () => [] as CtaInventoryEntry[],
  );
  notes.push(`no submit control matched; ${inventory.length} CTA candidates inventoried`);
  return { found: false, notes, inventory };
}
