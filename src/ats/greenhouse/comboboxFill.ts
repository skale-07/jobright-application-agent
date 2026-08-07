import type { Locator, Page } from "playwright";

/**
 * Phase 5.6 live finding: Greenhouse job-boards renders selects as
 * React-select-style comboboxes. `.fill()` on them types filter text into
 * the inner input without ever committing an option — the UI keeps showing
 * "Select..." while inputValue() lies that something was entered. This
 * module opens, filters, picks a REAL option from the rendered list, and
 * confirms commitment from the visible display. Values are never invented:
 * no matching option means no selection plus a loud error.
 *
 * Live job-boards quirks handled here:
 * - Country options look like "United States +1"; display may collapse to "+1"
 * - Degree taxonomy uses "Bachelor's Degree" not "Bachelor of Science"
 * - Async / virtualized menus need sequential typing, not a single fill()
 */

export type ControlKind = "native_select" | "combobox" | "text";

export type ComboboxFillResult = {
  committed: boolean;
  selectedLabel: string | null;
  notes: string[];
  /** First visible options at pick time (training signal). */
  optionsSample?: string[];
  /** How the option was matched: exact | synonym | unique_substring | ci_exact */
  pickVia?: string | null;
};

export type OptionPick =
  | { ok: true; label: string; via: "exact" | "ci_exact" | "unique_substring" | "synonym" }
  | { ok: false; reason: string };

const PLACEHOLDER_RE = /^select\.{0,3}…?$|^select…$|^select\.\.\.$/i;

/** "United States +1" → "united states" */
export function stripDialCode(s: string): string {
  return s.replace(/\s*\+\d+\s*$/u, "").trim();
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Loose key for synonym / degree / punctuation-insensitive compare. */
function optionKey(s: string): string {
  return normalize(stripDialCode(s))
    .replace(/['']/g, "")
    .replace(/[^a-z0-9&+]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Known education vocabulary on Greenhouse job-boards. Profile strings are
 * often "Bachelor of Science"; options are "Bachelor's Degree".
 */
const DEGREE_BUCKETS: ReadonlyArray<readonly string[]> = [
  ["associate", "associates degree", "associate's degree"],
  [
    "bachelor",
    "bachelors",
    "bachelors degree",
    "bachelor degree",
    "bachelor of science",
    "bachelor of arts",
    "bachelor of engineering",
    "bs",
    "ba",
    "bsc",
    "b eng",
  ],
  [
    "master",
    "masters",
    "masters degree",
    "master degree",
    "master of science",
    "master of arts",
    "mba",
    "ms",
    "ma",
    "msc",
  ],
  ["phd", "ph d", "doctor of philosophy", "doctorate"],
  ["jd", "juris doctor", "j d"],
  ["md", "doctor of medicine", "m d"],
  ["high school", "secondary"],
];

function degreeBucket(key: string): number {
  const padded = ` ${key} `;
  for (let i = 0; i < DEGREE_BUCKETS.length; i++) {
    const bucket = DEGREE_BUCKETS[i]!;
    if (
      bucket.some((b) => {
        // Whole-token / whole-phrase match only — short codes like "ma"/"ms"/"bs"
        // must not fire inside "math" / "stats".
        if (b.length <= 3) {
          return padded.includes(` ${b} `) || key === b;
        }
        return key === b || key.includes(b) || b.includes(key);
      })
    ) {
      return i;
    }
  }
  return -1;
}

function yesNo(v: string): "yes" | "no" | null {
  const n = normalize(v);
  if (["yes", "y", "true", "1"].includes(n)) return "yes";
  if (["no", "n", "false", "0"].includes(n)) return "no";
  return null;
}

/**
 * Pure option matching: exact → case-insensitive exact → dial-stripped →
 * degree synonym → yes/no → unique substring (either direction).
 * Values are never invented: multi-hit substring refuses.
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

  // Country / phone-style labels: "United States" ↔ "United States +1"
  const strippedExp = optionKey(exp);
  const dialHits = options.filter((o) => optionKey(o) === strippedExp);
  if (dialHits.length === 1 && dialHits[0] !== undefined) {
    return { ok: true, label: dialHits[0], via: "ci_exact" };
  }
  // country dial substrings: optionKey compare already handled as dialHits.
  // Keep dial-stripped unique substring here too (tight length gate):
  const dialSub = options.filter((o) => {
      const ok = optionKey(o);
      return (
        ok.length > 0 &&
        (ok.includes(strippedExp) ||
          (strippedExp.includes(ok) &&
            ok.length >= Math.max(10, Math.floor(strippedExp.length * 0.6))))
      );
    });
  if (dialSub.length === 1 && dialSub[0] !== undefined && strippedExp.length >= 3) {
    return { ok: true, label: dialSub[0], via: "unique_substring" };
  }

  const expBucket = degreeBucket(strippedExp);
  if (expBucket >= 0) {
    const degHits = options.filter((o) => degreeBucket(optionKey(o)) === expBucket);
    if (degHits.length === 1 && degHits[0] !== undefined) {
      return { ok: true, label: degHits[0], via: "synonym" };
    }
    // Prefer bare "Bachelor's Degree" over longer specialized degrees when many.
    if (degHits.length > 1) {
      const prefer = degHits.find((o) =>
        /bachelor'?s degree|master'?s degree|associate'?s degree/i.test(o),
      );
      if (prefer) return { ok: true, label: prefer, via: "synonym" };
    }
  }

  const expYn = yesNo(exp);
  if (expYn) {
    const ynHits = options.filter((o) => yesNo(o) === expYn);
    if (ynHits.length === 1 && ynHits[0] !== undefined) {
      return { ok: true, label: ynHits[0], via: "ci_exact" };
    }
  }

  const sub = options.filter((o) => {
    const ok = optionKey(o);
    if (ok.length < 2 || strippedExp.length < 2) return false;
    // Prefer option that contains expected (filter refinements).
    if (ok.includes(strippedExp)) return true;
    // expected contains option only when the option is substantial —
    // blocks "Mathematics" from swallowing "Applied Mathematics".
    if (
      strippedExp.includes(ok) &&
      ok.length >= Math.max(10, Math.floor(strippedExp.length * 0.6))
    ) {
      return true;
    }
    return false;
  });
  if (sub.length === 1 && sub[0] !== undefined) {
    return { ok: true, label: sub[0], via: "unique_substring" };
  }
  if (sub.length > 1) {
    return {
      ok: false,
      reason: `ambiguous match for "${exp}": ${sub.slice(0, 5).join(" | ")}`,
    };
  }

  // Token overlap (discipline / school nicknames): "Applied Math & Stats"
  // may not exist on the GH board — prefer "Mathematics" / "Statistics…" over
  // a weak "Applied Health Services" hit.
  const tokens = strippedExp
    .split(/\s+/)
    .map((t) => t.replace(/&/g, "").trim())
    .filter((t) => t.length >= 3 && !["and", "the", "for", "of"].includes(t))
    .map((t) => {
      if (t === "stats" || t === "stat") return "statistic";
      if (t === "math" || t === "maths") return "math";
      if (t === "comp" || t === "cs") return "computer";
      return t;
    });
  if (tokens.length >= 1) {
    const scored = options
      .map((o) => {
        const ok = optionKey(o);
        let score = 0;
        for (const t of tokens) {
          if (ok.includes(t)) score += 1;
          else if (t === "math" && ok.includes("mathematic")) score += 3;
          else if (t === "statistic" && ok.includes("statistic")) score += 3;
          else if (t === "computer" && ok.includes("computer")) score += 3;
        }
        // Downgrade generic "applied …" matches that only hit "applied"
        if (
          score === 1 &&
          tokens.includes("applied") &&
          ok.startsWith("applied") &&
          !ok.includes("math") &&
          !ok.includes("stat")
        ) {
          score = 0;
        }
        return { o, score };
      })
      .filter((x) => x.score >= 1);
    scored.sort((a, b) => b.score - a.score);
    if (
      scored.length >= 1 &&
      scored[0] !== undefined &&
      (scored.length === 1 || scored[0].score > (scored[1]?.score ?? 0))
    ) {
      return { ok: true, label: scored[0].o, via: "unique_substring" };
    }
  }

  return {
    ok: false,
    reason: `no option matches "${exp}" (options: ${options.slice(0, 8).join(" | ")}${options.length > 8 ? " | …" : ""})`,
  };
}

/**
 * Whether the visible committed label matches the option we clicked.
 * Handles Greenhouse country UI collapsing "United States +1" → "+1".
 */
export function labelsCompatible(
  pickedLabel: string,
  display: string | null,
): boolean {
  if (display === null) return false;
  const d = display.replace(/\s+/g, " ").trim();
  if (d === "" || PLACEHOLDER_RE.test(d)) return false;

  const p = pickedLabel.replace(/\s+/g, " ").trim();
  if (p === "") return false;
  if (normalize(p) === normalize(d)) return true;

  // Never treat empty substring as a match — "".includes is always true.
  const np = normalize(p);
  const nd = normalize(d);
  if (np.length >= 2 && nd.length >= 2 && (np.includes(nd) || nd.includes(np))) {
    return true;
  }

  const op = optionKey(p);
  const od = optionKey(d);
  if (op.length === 0 || od.length === 0) return false;
  if (op === od) return true;
  if (op.length >= 2 && od.length >= 2 && (op.includes(od) || od.includes(op))) {
    return true;
  }
  // Dial-code-only display after picking "Country +N"
  if (/^\+\d+$/.test(d) && p.includes(d)) return true;
  return false;
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
      haspopup === "true" ||
      autocomplete === "list" ||
      autocomplete === "both"
    ) {
      return "combobox" as const;
    }
    if (
      el.closest('[class*="select__control"]') ||
      el.closest('[class*="select-shell"]') ||
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
    querySelector: (s: string) => {
      textContent: string | null;
      getAttribute?: (n: string) => string | null;
      childNodes?: ArrayLike<{ textContent?: string | null; nodeType?: number }>;
    } | null;
    textContent: string | null;
    closest: (s: string) => ContainerEl | null;
  };
  const raw = await loc.evaluate((el: ContainerEl) => {
    const shell =
      el.closest('[class*="select-shell"]') ??
      el.closest('[class*="select__control"]') ??
      el.closest('[class*="select_"]');
    if (!shell) return null;

    // ONLY the single-value node counts as committed — never the open menu or
    // the filter input. Using control textContent caused false positives when
    // the menu listed matching options while still on Select...
    const single = shell.querySelector(
      '[class*="single-value"], [class*="singleValue"]',
    );
    if (single) {
      const t = (single.textContent || "").replace(/\s+/g, " ").trim();
      if (t) return t;
      const title = single.getAttribute?.("title");
      if (title) return title;
    }
    return null;
  });
  if (raw === null) return null;
  const text = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^select\.{0,3}…?\s*/i, "")
    .replace(/\s*select\.{0,3}…?$/i, "")
    .trim();
  if (text === "" || PLACEHOLDER_RE.test(text)) return null;
  return text;
}

const LISTBOX_SELECTOR = '[role="listbox"], [class*="select__menu"]';
const OPTION_SELECTOR = '[role="option"], [class*="select__option"]';

/** Progressive filter strings for virtualized React-select menus. */
export function buildFilterCandidates(expected: string): string[] {
  const full = expected.trim();
  if (full === "") return [];
  const cleaned = full
    .replace(/[&|,/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = cleaned.split(" ").filter((w) => w.length > 0);
  const out: string[] = [];
  const push = (s: string) => {
    const t = s.trim().slice(0, 40);
    if (t && !out.includes(t)) out.push(t);
  };
  push(full);
  push(cleaned);
  if (words.length >= 3) push(words.slice(0, 3).join(" "));
  if (words.length >= 2) push(words.slice(0, 2).join(" "));
  if (words.length >= 1) push(words[0]!);
  // Domain-weighted probes last: Greenhouse catalogues often lack nicknames
  // like "Applied Math & Stats" but have "Mathematics" / "Statistics…".
  const lower = cleaned.toLowerCase();
  if (/\bmath/.test(lower)) {
    push("Mathematics");
    push("Math");
  }
  if (/\bstat/.test(lower)) {
    push("Statistics");
  }
  if (/\bcomputer|\bcs\b/.test(lower)) {
    push("Computer Science");
    push("Computer");
  }
  // Remaining content words (skip filler)
  for (const w of words) {
    if (
      w.length >= 4 &&
      !["applied", "science", "studies", "with"].includes(w.toLowerCase())
    ) {
      push(w);
    }
  }
  return out;
}

async function openCombobox(
  page: Page,
  loc: Locator,
): Promise<{ clickTarget: Locator; notes: string[] }> {
  const notes: string[] = [];
  const control = loc
    .locator(
      'xpath=ancestor-or-self::*[contains(@class,"select__control") or contains(@class,"select-shell") or @role="combobox"][1]',
    )
    .first();
  const clickTarget = (await control.count()) > 0 ? control : loc;
  // force: inner input is often 3×20; the control div is the real hit target
  await clickTarget.click({ timeout: 10_000, force: true });
  notes.push("opened via control click");
  await page.waitForTimeout(150);
  return { clickTarget, notes };
}

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

  const opened = await openCombobox(page, loc);
  notes.push(...opened.notes);

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

  // Filter with sequential typing — React-select often ignores a single fill()
  // and virtualized menus only expose matching rows after the filter settles.
  // Progressive filters: full string → strip punctuation → head tokens.
  let options: string[] = [];
  const filterCandidates = buildFilterCandidates(expectedText);
  try {
    await loc.click({ force: true, timeout: 3_000 }).catch(() => undefined);
    for (const typeText of filterCandidates) {
      // Clear prior filter without collapsing the menu when possible.
      await loc.evaluate((el: { focus: () => void; value: string }) => {
        el.focus();
        el.value = "";
      }).catch(() => undefined);
      // keyboard.type reaches React onZero-size combobox inputs more reliably than fill().
      await page.keyboard.type(typeText, { delay: 25 });
      options = [];
      for (let i = 0; i < 18; i++) {
        await page.waitForTimeout(120);
        options = await collectOptions();
        if (options.length === 0) continue;
        if (pickOptionLabel(options, expectedText).ok) break;
      }
      if (pickOptionLabel(options, expectedText).ok) {
        notes.push(
          `filter "${typeText}" → ${options.length} option(s); match`,
        );
        break;
      }
    }
    if (options.length === 0 || !pickOptionLabel(options, expectedText).ok) {
      // Re-open and dump unfiltered (first virtualization window).
      await page.keyboard.press("Escape").catch(() => undefined);
      await openCombobox(page, loc);
      await listbox.waitFor({ state: "visible", timeout: 3_000 }).catch(() => undefined);
      await page.waitForTimeout(250);
      options = await collectOptions();
      notes.push("filter yielded no/unmatched options; re-collected unfiltered");
    }
  } catch {
    options = await collectOptions();
    notes.push("control not typeable; using unfiltered options");
  }

  const pick = pickOptionLabel(options, expectedText);
  const optionsSample = options.slice(0, 20);
  if (!pick.ok) {
    notes.push(pick.reason);
    await page.keyboard.press("Escape").catch(() => undefined);
    await loc.fill("").catch(() => undefined);
    return {
      committed: false,
      selectedLabel: null,
      notes,
      optionsSample,
      pickVia: null,
    };
  }

  // Prefer role=option exact text when Playwright can resolve it; fall back to
  // substring filter if whitespace / flag chrome differs.
  const optionByRole = page.getByRole("option", { name: pick.label, exact: true });
  let option = optionByRole.filter({ visible: true }).first();
  if ((await option.count().catch(() => 0)) === 0) {
    option = page
      .locator(OPTION_SELECTOR)
      .filter({ visible: true })
      .filter({ hasText: pick.label })
      .first();
  }
  await option.click({ timeout: 5_000, force: true });
  notes.push(`picked "${pick.label}" (${pick.via})`);

  await listbox
    .waitFor({ state: "hidden", timeout: 5_000 })
    .catch(() => notes.push("listbox still visible after pick"));
  await page.waitForTimeout(200);

  const committedLabel = await readComboboxValue(loc);
  const committed = labelsCompatible(pick.label, committedLabel);
  if (!committed) {
    notes.push(
      `commit not confirmed: display shows ${committedLabel === null ? "placeholder" : `"${committedLabel}"`}`,
    );
  }
  // Prefer the richer option label over dial-code-only collapse ("+1").
  let selectedLabel = committedLabel;
  if (committed && committedLabel && /^\+\d+$/.test(committedLabel.trim())) {
    selectedLabel = stripDialCode(pick.label) || pick.label;
    notes.push(`display collapsed to dial code; recording "${selectedLabel}"`);
  } else if (committed && !committedLabel) {
    selectedLabel = stripDialCode(pick.label) || pick.label;
  }
  return {
    committed,
    selectedLabel,
    notes,
    optionsSample,
    pickVia: pick.via,
  };
}
