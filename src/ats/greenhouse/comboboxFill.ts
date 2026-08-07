import type { Locator, Page } from "playwright";

/**
 * Phase 5.6 live finding: Greenhouse job-boards renders selects as
 * React-select-style comboboxes. `.fill()` on them types filter text into
 * the inner input without ever committing an option — the UI keeps showing
 * "Select..." while inputValue() lies that something was entered. This
 * module opens, filters, picks a REAL option from the rendered list, and
 * confirms commitment from the visible display. Values are never invented:
 * no matching option means no selection plus a loud error.
 */

export type ControlKind = "native_select" | "combobox" | "text";

export type ComboboxFillResult = {
  committed: boolean;
  selectedLabel: string | null;
  notes: string[];
};

export type OptionPick =
  | { ok: true; label: string; via: "exact" | "ci_exact" | "unique_substring" }
  | { ok: false; reason: string };

const PLACEHOLDER_RE = /^select\.{0,3}…?$|^select…$|^select\.\.\.$/i;

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Pure option matching: exact → case-insensitive exact → unique
 * case-insensitive substring in either direction ("Applied Math" picks
 * "Applied Mathematics & Statistics" only when it is the single hit).
 * Yes/No synonyms mirror valuesMatch.
 */
export function pickOptionLabel(options: string[], expected: string): OptionPick {
  const exp = expected.trim();
  if (exp === "") return { ok: false, reason: "expected value is empty" };

  const exact = options.find((o) => o.trim() === exp);
  if (exact) return { ok: true, label: exact, via: "exact" };

  const ciExact = options.filter((o) => normalize(o) === normalize(exp));
  if (ciExact.length === 1 && ciExact[0] !== undefined) {
    return { ok: true, label: ciExact[0], via: "ci_exact" };
  }

  // Yes/No normalization consistent with valuesMatch.
  const yesNo = (v: string): "yes" | "no" | null => {
    const n = normalize(v);
    if (["yes", "y", "true", "1"].includes(n)) return "yes";
    if (["no", "n", "false", "0"].includes(n)) return "no";
    return null;
  };
  const expYn = yesNo(exp);
  if (expYn) {
    const ynHits = options.filter((o) => yesNo(o) === expYn);
    if (ynHits.length === 1 && ynHits[0] !== undefined) {
      return { ok: true, label: ynHits[0], via: "ci_exact" };
    }
  }

  const sub = options.filter(
    (o) =>
      normalize(o).includes(normalize(exp)) ||
      normalize(exp).includes(normalize(o)),
  );
  if (sub.length === 1 && sub[0] !== undefined) {
    return { ok: true, label: sub[0], via: "unique_substring" };
  }
  if (sub.length > 1) {
    return {
      ok: false,
      reason: `ambiguous match for "${exp}": ${sub.slice(0, 5).join(" | ")}`,
    };
  }
  return {
    ok: false,
    reason: `no option matches "${exp}" (options: ${options.slice(0, 8).join(" | ")}${options.length > 8 ? " | …" : ""})`,
  };
}

/**
 * Classify the live control. Role/aria evidence first; hashed-class
 * fallbacks (React-select "select__control", select2) are last because
 * Greenhouse's CSS-module names churn.
 */
export async function detectControlKind(loc: Locator): Promise<ControlKind> {
  return loc.evaluate((el: {
    tagName: string;
    getAttribute: (n: string) => string | null;
    closest: (s: string) => unknown;
  }) => {
    if (el.tagName === "SELECT") return "native_select" as const;
    const role = el.getAttribute("role") ?? "";
    const haspopup = el.getAttribute("aria-haspopup") ?? "";
    const autocomplete = el.getAttribute("aria-autocomplete") ?? "";
    if (
      role === "combobox" ||
      haspopup === "listbox" ||
      autocomplete === "list" ||
      autocomplete === "both"
    ) {
      return "combobox" as const;
    }
    if (
      el.closest('[class*="select__control"]') ||
      el.closest('[class*="select2"]') ||
      el.closest('[role="combobox"]')
    ) {
      return "combobox" as const;
    }
    return "text" as const;
  });
}

/** Committed display text, or null while the placeholder is showing. */
export async function readComboboxValue(loc: Locator): Promise<string | null> {
  type ContainerEl = {
    querySelector: (s: string) => { textContent: string | null } | null;
    textContent: string | null;
    closest: (s: string) => ContainerEl | null;
  };
  const raw = await loc.evaluate((el: ContainerEl) => {
    const container =
      el.closest('[class*="select__control"]') ??
      el.closest('[class*="select_"]') ??
      el.closest("div");
    if (!container) return null;
    // React-select renders the committed choice into a *single-value node.
    const single = container.querySelector(
      '[class*="single-value"], [class*="singleValue"]',
    );
    if (single?.textContent) return single.textContent;
    return container.textContent;
  });
  if (raw === null) return null;
  const text = raw.replace(/\s+/g, " ").trim();
  if (text === "" || PLACEHOLDER_RE.test(text)) return null;
  // Container fallback may include the placeholder plus other chrome.
  if (/^select\.{0,3}…?/i.test(text)) return null;
  return text;
}

const LISTBOX_SELECTOR = '[role="listbox"], [class*="select__menu"]';
const OPTION_SELECTOR = '[role="option"], [class*="select__option"]';

/**
 * Open → (filter) → pick a real option → confirm commitment.
 * Returns committed:false with notes rather than leaving filter residue —
 * the caller records an error and the field stays honestly unfilled.
 */
export async function fillComboboxControl(
  page: Page,
  loc: Locator,
  expected: unknown,
): Promise<ComboboxFillResult> {
  const notes: string[] = [];
  const expectedText = String(expected);

  // Open via the visible control (the inner input can be zero-size).
  const control = loc
    .locator(
      'xpath=ancestor-or-self::*[contains(@class,"select__control") or @role="combobox"][1]',
    )
    .first();
  const clickTarget = (await control.count()) > 0 ? control : loc;
  await clickTarget.click({ timeout: 10_000 });

  // Multiple menus exist in the DOM (one per combobox); only the one just
  // opened is visible — scope everything to visible elements.
  const listbox = page
    .locator(LISTBOX_SELECTOR)
    .filter({ visible: true })
    .first();
  try {
    await listbox.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    notes.push("listbox did not open after click");
    return { committed: false, selectedLabel: null, notes };
  }

  const collectOptions = async (): Promise<string[]> =>
    (
      await page
        .locator(OPTION_SELECTOR)
        .filter({ visible: true })
        .allTextContents()
    )
      .map((t) => t.replace(/\s+/g, " ").trim())
      .filter((t) => t.length > 0);

  // Filter when the control accepts typing (helps long lists like country).
  let options: string[] = [];
  try {
    await loc.fill(expectedText, { timeout: 3_000 });
    await page.waitForTimeout(300);
    options = await collectOptions();
    if (options.length === 0) {
      await loc.fill("", { timeout: 2_000 }).catch(() => undefined);
      await page.waitForTimeout(300);
      options = await collectOptions();
      notes.push("filter yielded no options; re-collected unfiltered");
    }
  } catch {
    options = await collectOptions();
    notes.push("control not typeable; using unfiltered options");
  }

  const pick = pickOptionLabel(options, expectedText);
  if (!pick.ok) {
    notes.push(pick.reason);
    // Close without committing anything — no invented values, no residue.
    await page.keyboard.press("Escape").catch(() => undefined);
    await loc.fill("", { timeout: 1_500 }).catch(() => undefined);
    return { committed: false, selectedLabel: null, notes };
  }

  const option = page
    .locator(OPTION_SELECTOR)
    .filter({ visible: true })
    .filter({ hasText: pick.label })
    .first();
  await option.click({ timeout: 5_000 });
  notes.push(`picked "${pick.label}" (${pick.via})`);

  await listbox
    .waitFor({ state: "hidden", timeout: 5_000 })
    .catch(() => notes.push("listbox still visible after pick"));
  await page.waitForTimeout(200);

  const committedLabel = await readComboboxValue(loc);
  const committed =
    committedLabel !== null &&
    normalize(committedLabel).includes(normalize(pick.label).slice(0, 40));
  if (!committed) {
    notes.push(
      `commit not confirmed: display shows ${committedLabel === null ? "placeholder" : `"${committedLabel}"`}`,
    );
  }
  return { committed, selectedLabel: committedLabel, notes };
}
