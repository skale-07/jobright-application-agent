import type { Locator, Page } from "playwright";
import type { DiscoveredField } from "../adapter.js";

/**
 * Scrape each control's REAL outcome space from the live page, before the
 * fill plan is made.
 *
 * Why this exists (operator directive 2026-08-14, "first scraping the
 * possible outcomes for each field is probably the most efficient
 * solution"): `planApplicationFill` is HTML-only. `discoverFieldsFromHtml`
 * can read `<option>` children of a native `<select>` and nothing else —
 * and modern boards do not ship native selects. Greenhouse job-boards,
 * Lever, Ashby and Workday all render React-select style comboboxes whose
 * option list exists only after the control is opened. So every one of
 * those fields reached the planner with `options: undefined`, and every
 * downstream tier degraded accordingly:
 *
 *   - `resolveScreenerAnswer` saw a choice control with zero options and
 *     fell through to `basis: "free_text"` — typing a stored string blind
 *     into a typeahead.
 *   - `predictAnswersForQuestions` was asked to answer with no option list,
 *     so its answer was validated only as free text.
 *   - `selectScreenerOptions` (the tier whose entire job is choosing from
 *     the page's own list) was skipped: it requires `options.length > 0`.
 *
 * Live evidence (Appian / job-boards.greenhouse.io, run aef17b3e): the
 * planner produced "Summer Atlantic Capital" for a university-organizations
 * dropdown. The board's own list did not contain it — it contained
 * "Other" — so the typeahead showed "No options" and the field stayed
 * empty. Nothing in the pipeline was wrong about the candidate; the model
 * and the matcher were both answering a question whose answer space they
 * had never been shown.
 *
 * With the list in hand every tier's existing verbatim validation starts
 * working as designed: the matcher can match, the model must copy an option
 * character-for-character, and a fallback option the form itself offers
 * ("Other", "Prefer not to say") becomes a legitimate, grounded answer
 * instead of an invention.
 *
 * SAFETY: harvesting is read-only with respect to field VALUES. It opens a
 * control and reads the rendered list; it never clicks an option, never
 * types filter text, and presses Escape before moving on. It runs only on
 * the execute path — which is already behind FORM_FILL_ENABLED / DRY_RUN —
 * and it is fail-open: a control that will not open contributes no options
 * and the field parks exactly as it did before this module existed.
 */

export type HarvestBasis = "native_select" | "opened_listbox";

/**
 * The two answer classes an application field can have (operator directive
 * 2026-08-14). They are different problems and must not share a strategy:
 *
 *   - CLOSED — a dropdown / listbox / radio group. The answer space is the
 *     scraped option list and nothing else. Typing a string that is not on
 *     that list produces "No options" and an empty field, which is exactly
 *     the Appian failure. A closed field is answerable ONLY by choosing.
 *   - OPEN — a plain text / textarea control. Anything typeable is a valid
 *     answer, so the stored or predicted string can be written directly and
 *     no option list is needed.
 *
 * Naming the class is what lets the planner stop applying the open strategy
 * to a closed field.
 */
export type AnswerSpace = "closed" | "open";

export type FieldOptionHarvest = {
  field_id: string;
  label: string;
  options: string[];
  basis: HarvestBasis;
  answer_space: AnswerSpace;
  /** The option that means "not listed" ("Other", "Prefer to self-describe"). */
  other_option: string | null;
};

export type OptionHarvestResult = {
  /** field id → the options that control actually offers. */
  options: Map<string, string[]>;
  /** field id → closed (choose only) vs open (type anything). */
  answerSpace: Map<string, AnswerSpace>;
  /** Per-field record for the artifact — what was scraped and how. */
  harvested: FieldOptionHarvest[];
  notes: string[];
};

/**
 * The form's own escape hatch for "my answer is not on your list". Picking
 * it is following the form, not guessing — and it is frequently the only
 * correct answer (Appian's university-organizations question offered no
 * real organization the candidate belongs to, only "Other").
 *
 * Deliberately narrow: "Other" and self-describe phrasings only. A decline
 * option ("Prefer not to say") is NOT an other-option — declining is a
 * different answer with a different meaning, and choosing it for the
 * candidate is putting words in their mouth.
 */
export function findOtherOption(options: string[]): string | null {
  const isOther = (o: string): boolean => {
    const k = o.toLowerCase().replace(/\s+/g, " ").trim().replace(/[^a-z0-9 ]/g, "");
    return (
      k === "other" ||
      k === "others" ||
      /^other\b/.test(k) ||
      /^none of the above$/.test(k) ||
      /^not listed\b/.test(k) ||
      /\bprefer to self describe\b/.test(k)
    );
  };
  const hits = options.filter(isOther);
  if (hits.length === 0) return null;
  // Prefer the bare "Other" when a form offers both "Other" and
  // "Other (please specify)" — either works, the shorter is unambiguous.
  const bare = hits.find((o) => /^other$/i.test(o.trim()));
  return bare ?? hits[0]!;
}

/** One form does not have 40 dropdowns; a runaway page must not stall a run. */
const MAX_FIELDS = 30;
const MAX_OPTIONS_PER_FIELD = 60;
/** Whole-pass wall clock. Past this the plan proceeds with what it has. */
const DEFAULT_BUDGET_MS = 45_000;
const OPEN_TIMEOUT_MS = 2_500;
const LISTBOX_SELECTOR = '[role="listbox"], [class*="select__menu"], [class*="menu-list"]';
const OPTION_SELECTOR = '[role="option"], [class*="select__option"], [class*="option-item"]';

/**
 * Controls worth opening. A file input, a checkbox, or a free-text name
 * field has no outcome space to scrape — only select-likes do. `text` is
 * included because every React-select renders its inner filter as a plain
 * `<input type="text">`: `detectControlKind` on the live element is what
 * actually decides, not the HTML-derived type.
 */
function isHarvestCandidate(f: DiscoveredField): boolean {
  if ((f.options?.length ?? 0) > 0) return false; // already known from HTML
  return f.type === "select" || f.type === "text";
}

function locatorForField(page: Page, field: DiscoveredField): Locator | null {
  if (field.inputId) {
    const escaped = field.inputId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return page.locator(`[id="${escaped}"]`).first();
  }
  if (field.name) {
    return page.locator(`[name="${field.name.replace(/"/g, '\\"')}"]`).first();
  }
  return null;
}

/**
 * Is this live element a select-like at all? Mirrors the greenhouse
 * combobox detector's evidence order (role/aria first, hashed classes
 * last) but stays vendor-blind so Lever/Ashby/Workday/generic all harvest.
 */
async function detectSelectKind(
  loc: Locator,
): Promise<"native_select" | "combobox" | "other"> {
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
    return "other" as const;
  });
}

function cleanOptions(raw: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const t = r.replace(/\s+/g, " ").trim();
    if (t === "") continue;
    // React-select renders a "no results" row as an option node. It is a
    // status message, not an answer — the Appian live failure showed
    // exactly this string sitting where an option list should be.
    if (/^(no options|no results|loading|searching)\b/i.test(t)) continue;
    if (/^select\.{0,3}…?$/i.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_OPTIONS_PER_FIELD) break;
  }
  return out;
}

/** Live `<option>` text — catches selects a SPA populated after first paint. */
async function readNativeOptions(loc: Locator): Promise<string[]> {
  const raw = await loc.locator("option").allTextContents();
  return cleanOptions(raw).filter((o) => !/^-+$/.test(o));
}

/**
 * Open the combobox, read the rendered list, close it. No option is ever
 * clicked and no filter text is ever typed, so the control's value is the
 * same after this call as before it.
 */
async function readListboxOptions(
  page: Page,
  loc: Locator,
): Promise<string[]> {
  const control = loc
    .locator(
      'xpath=ancestor-or-self::*[contains(@class,"select__control") or contains(@class,"select-shell") or @role="combobox"][1]',
    )
    .first();
  const clickTarget = (await control.count().catch(() => 0)) > 0 ? control : loc;
  await clickTarget.scrollIntoViewIfNeeded().catch(() => undefined);
  await clickTarget.click({ timeout: OPEN_TIMEOUT_MS, force: true });

  const listbox = page.locator(LISTBOX_SELECTOR).filter({ visible: true }).first();
  try {
    await listbox.waitFor({ state: "visible", timeout: OPEN_TIMEOUT_MS });
  } catch {
    await page.keyboard.press("Escape").catch(() => undefined);
    return [];
  }
  // Virtualized menus mount rows over a few frames; poll briefly for a
  // stable count rather than sleeping a fixed amount.
  let options: string[] = [];
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(100);
    const next = cleanOptions(
      await page
        .locator(OPTION_SELECTOR)
        .filter({ visible: true })
        .allTextContents(),
    );
    if (next.length > 0 && next.length === options.length) break;
    options = next;
  }
  await page.keyboard.press("Escape").catch(() => undefined);
  return options;
}

/**
 * Harvest the outcome space for every select-like control on the page.
 * Fail-open by construction: any control that throws is skipped with a
 * note and the plan proceeds with the options it does have.
 */
export async function harvestFieldOptions(
  page: Page,
  fields: DiscoveredField[],
  opts?: { budgetMs?: number; maxFields?: number },
): Promise<OptionHarvestResult> {
  const result: OptionHarvestResult = {
    options: new Map(),
    answerSpace: new Map(),
    harvested: [],
    notes: [],
  };
  const budgetMs = opts?.budgetMs ?? DEFAULT_BUDGET_MS;
  const maxFields = opts?.maxFields ?? MAX_FIELDS;
  const candidates = fields.filter(isHarvestCandidate);
  if (candidates.length === 0) return result;

  const started = Date.now();
  let opened = 0;
  let examined = 0;
  let budgetHit = false;
  for (const field of candidates.slice(0, maxFields)) {
    if (Date.now() - started > budgetMs) {
      budgetHit = true;
      result.notes.push(
        `option harvest: budget ${Math.round(budgetMs / 1000)}s reached after ${examined} control(s) — planning with what was scraped`,
      );
      break;
    }
    const loc = locatorForField(page, field);
    if (!loc) continue;
    examined += 1;
    try {
      if ((await loc.count()) === 0) continue;
      const kind = await detectSelectKind(loc);
      if (kind === "other") {
        // Probed and it is a plain input: an OPEN answer space. Saying so
        // explicitly is what lets the planner type a free-text answer with
        // confidence instead of treating every unknown control as risky.
        result.answerSpace.set(field.id, "open");
        continue;
      }
      const options =
        kind === "native_select"
          ? await readNativeOptions(loc)
          : await readListboxOptions(page, loc);
      if (options.length === 0) {
        // A select-like that will not show a list is NOT open — typing into
        // it is the blind-typeahead failure. It stays unclassified so the
        // planner keeps its existing park-for-review behavior.
        result.notes.push(
          `option harvest: "${field.label.slice(0, 60)}" is a ${kind} but offered no readable options`,
        );
        continue;
      }
      opened += 1;
      result.options.set(field.id, options);
      result.answerSpace.set(field.id, "closed");
      result.harvested.push({
        field_id: field.id,
        label: field.label,
        options,
        basis: kind === "native_select" ? "native_select" : "opened_listbox",
        answer_space: "closed",
        other_option: findOtherOption(options),
      });
    } catch (err) {
      result.notes.push(
        `option harvest: "${field.label.slice(0, 60)}" could not be opened (${err instanceof Error ? err.message.slice(0, 80) : String(err)})`,
      );
      // Leave nothing half-open in front of the next control.
      await page.keyboard.press("Escape").catch(() => undefined);
    }
  }
  if (candidates.length > maxFields && !budgetHit) {
    result.notes.push(
      `option harvest: ${candidates.length} select-like controls, capped at ${maxFields}`,
    );
  }
  if (opened > 0) {
    result.notes.push(
      `option harvest: scraped real options for ${opened}/${examined} control(s) before planning`,
    );
  }
  return result;
}

/**
 * Merge an option source keyed by QUESTION TEXT rather than field id —
 * the shape a board's own API publishes (see greenhouse/questionsApi.ts),
 * which knows the questions but not our DOM ids.
 *
 * A truncated DOM read is worse than no read: a virtualized menu renders
 * only its first window, so a 22-option list can arrive as 8. When the
 * board itself declares the list, that declaration wins — it is complete
 * by construction and cannot be cut short by a scroll position.
 *
 * Matching is exact on normalized text, then prefix, because boards
 * truncate long labels in the DOM ("Are you currently pursuing a Major in
 * one of the following disciplines: Com…") while the API returns them
 * whole. A prefix match must be substantial (≥ 20 chars) so short generic
 * labels never collide.
 */
export function applyLabelOptions(
  fields: DiscoveredField[],
  byLabel: Map<string, string[]>,
): { fields: DiscoveredField[]; matched: number } {
  if (byLabel.size === 0) return { fields, matched: 0 };
  const norm = (s: string): string =>
    s.toLowerCase().replace(/\s+/g, " ").replace(/[^a-z0-9 ]/g, "").trim();
  const entries = [...byLabel.entries()];
  let matched = 0;
  const out = fields.map((f) => {
    const key = norm(f.label);
    if (key.length === 0) return f;
    let options = byLabel.get(key);
    if (!options && key.length >= 20) {
      const prefixHits = entries.filter(
        ([k]) => k.startsWith(key) || key.startsWith(k),
      );
      if (prefixHits.length === 1) options = prefixHits[0]![1];
    }
    if (!options || options.length === 0) return f;
    matched += 1;
    return { ...f, options };
  });
  return { fields: out, matched };
}

/**
 * Merge harvested options onto the discovered fields. The HTML-derived
 * list wins when it exists (a native `<select>`'s markup is authoritative);
 * the harvest only fills in what the markup could not say.
 */
export function applyHarvestedOptions(
  fields: DiscoveredField[],
  harvested: Map<string, string[]>,
): DiscoveredField[] {
  if (harvested.size === 0) return fields;
  return fields.map((f) => {
    if ((f.options?.length ?? 0) > 0) return f;
    const options = harvested.get(f.id);
    if (!options || options.length === 0) return f;
    return { ...f, options };
  });
}
