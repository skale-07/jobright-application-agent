import type { Page, Locator } from "playwright";
import fs from "node:fs";
import path from "node:path";
import type {
  FieldFillMeta,
  FillResult,
  FormResetResult,
  FormVerificationResult,
  ResolvedApplicationAnswers,
  UploadVerification,
} from "../adapter.js";
import { greenhouseSelectorsV1 } from "./selectors.js";
import type { FillPlanEntry } from "../../applications/resolveAnswers.js";
import {
  assertExecutableApprovedEntry,
  type ApprovedFillPlanEntry,
} from "../../applications/approvedFillPlan.js";
import { assertFormFillAllowed } from "../../applications/formFillGuards.js";
import {
  detectControlKind,
  fillComboboxControl,
  labelsCompatible,
  pickOptionLabel,
  readComboboxValue,
} from "./comboboxFill.js";
import { logger } from "../../logging/logger.js";
import { locationsMatch } from "../../applications/locationQuery.js";

export type FieldMeta = {
  name?: string;
  inputId?: string;
  type: FillPlanEntry["type"];
};

export type ExecutableFillEntry = ApprovedFillPlanEntry | FillPlanEntry;

export function locatorForField(
  page: Page,
  entry: Pick<FillPlanEntry, "field_id" | "label"> & {
    name?: string;
    inputId?: string;
  },
): Locator {
  if (entry.inputId) {
    // Greenhouse free-text / EEO question ids are pure digits (e.g. 4010536008).
    // Those are invalid as bare CSS `#id` — always attribute-select.
    const escaped = entry.inputId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return page.locator(`[id="${escaped}"]`).first();
  }
  if (entry.name) {
    return page.locator(`[name="${entry.name.replace(/"/g, '\\"')}"]`).first();
  }
  return page.getByLabel(entry.label, { exact: false }).first();
}

async function setSelectByValueOrLabel(
  locator: Locator,
  value: unknown,
): Promise<void> {
  const text = String(value);
  try {
    await locator.selectOption({ label: text });
    return;
  } catch {
    // fall through
  }
  try {
    await locator.selectOption({ value: text.toLowerCase() });
    return;
  } catch {
    // fall through
  }
  const options = await locator.locator("option").allTextContents();
  const match = options.find(
    (o) => o.trim().toLowerCase() === text.toLowerCase(),
  );
  if (match) {
    await locator.selectOption({ label: match });
    return;
  }
  const partial = options.find((o) =>
    o.toLowerCase().includes(text.toLowerCase()),
  );
  if (partial) {
    await locator.selectOption({ label: partial });
    return;
  }
  // "I am not a protected veteran" → "I am not a veteran"
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !/^(the|and|not|are|you)$/.test(t));
  const byTokens = options.find((o) => {
    const ol = o.toLowerCase();
    return tokens.filter((t) => ol.includes(t)).length >= Math.min(2, tokens.length);
  });
  if (byTokens) {
    await locator.selectOption({ label: byTokens });
    return;
  }
  throw new Error(
    `No select option matching "${text}" (options: ${options.join(", ")})`,
  );
}

function isLocationStyleField(entry: {
  field_id: string;
  label: string;
  canonical_field?: string | null;
  name?: string;
  inputId?: string;
}): boolean {
  if (entry.canonical_field === "address.city") return true;
  const blob = `${entry.field_id} ${entry.label} ${entry.name ?? ""} ${entry.inputId ?? ""}`.toLowerCase();
  return (
    blob.includes("location-input") ||
    /\bcurrent location\b/.test(blob) ||
    /^location$/.test(entry.label.trim().toLowerCase())
  );
}

/**
 * Lever/GH "Current location" style fields: type city (prefer city + state),
 * wait for an autocomplete dropdown, click a match or the first row, then
 * keyboard ArrowDown+Enter as last resort. Plain fill alone does NOT commit
 * Places-style widgets (they clear unselected text on blur).
 */
async function fillLocationStyleText(
  page: Page,
  loc: Locator,
  value: unknown,
): Promise<{ notes: string[] }> {
  const text = String(value).trim();
  const notes: string[] = [];
  if (!text) {
    notes.push("location fill skipped — empty value");
    return { notes };
  }

  await loc.scrollIntoViewIfNeeded().catch(() => undefined);
  await loc.click({ timeout: 5_000 });
  // Clear residual/autocomplete cache
  await loc.fill("");
  await loc.press("Control+A").catch(() => undefined);
  await loc.press("Backspace").catch(() => undefined);

  // Type so key events fire (many widgets ignore .fill for suggestions).
  await loc.pressSequentially(text, { delay: 40 });
  // Nudge filters that key up only after a pause
  await page.waitForTimeout(350);

  const suggestionSelectors = [
    ".pac-item:visible",
    ".pac-container .pac-item",
    '[role="listbox"] [role="option"]:visible',
    '[role="option"]:visible',
    "ul.dropdown-menu li:visible",
    ".tt-suggestion:visible",
    ".autocomplete-suggestion:visible",
    ".location-typeahead-option:visible",
    "[class*='suggestion']:visible",
    "[class*='dropdown'] li:visible",
    "[class*='Dropdown'] [class*='option']:visible",
    "[data-testid*='location'] [role='option']",
  ];

  const itemsLocator = page.locator(suggestionSelectors.join(", "));

  let chose = false;
  const deadline = Date.now() + 3_500;
  while (Date.now() < deadline && !chose) {
    const count = await itemsLocator.count().catch(() => 0);
    if (count > 0) {
      notes.push(`suggestions visible: ${count}`);
      const lower = text.toLowerCase();
      // Prefer a row that contains the typed city token.
      let pickIndex = 0;
      for (let i = 0; i < Math.min(count, 12); i++) {
        const t = ((await itemsLocator.nth(i).innerText().catch(() => "")) ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        if (!t) continue;
        const cityToken = lower.split(/[,\s]+/)[0] ?? lower;
        if (t.includes(cityToken) || cityToken.length >= 4 && t.includes(cityToken.slice(0, 4))) {
          pickIndex = i;
          notes.push(`matched suggestion index ${i}: ${t.slice(0, 80)}`);
          break;
        }
      }
      if (pickIndex === 0 && count > 0) {
        notes.push("no city-token match — clicking first suggestion");
      }
      try {
        await itemsLocator.nth(pickIndex).click({ timeout: 2_000 });
        chose = true;
        notes.push(`clicked suggestion index ${pickIndex}`);
      } catch (err) {
        notes.push(
          `click suggestion failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      break;
    }
    await page.waitForTimeout(150);
  }

  if (!chose) {
    // Keyboard commit: first highlighted option (standard autocomplete contract).
    notes.push("no clickable suggestion list within timeout — ArrowDown+Enter");
    await loc.focus();
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(120);
    await page.keyboard.press("Enter");
    chose = true;
    notes.push("keyboard ArrowDown+Enter");
  }

  await page.waitForTimeout(200);
  await loc.evaluate(
    (el: {
      dispatchEvent: (e: Event) => void;
      getAttribute: (n: string) => string | null;
      textContent: string | null;
      closest: (s: string) => {
        querySelector: (s: string) => { textContent: string | null } | null;
      } | null;
      parentElement: {
        querySelector: (s: string) => { textContent: string | null } | null;
      } | null;
    }) => {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
  );

  let readBack = (await loc.inputValue().catch(() => "")).trim();
  // Some Lever UIs put the committed value in a nearby selected label.
  if (!readBack) {
    readBack = (
      await loc.evaluate(
        (el: {
          getAttribute: (n: string) => string | null;
          textContent: string | null;
          closest: (s: string) => {
            querySelector: (s: string) => { textContent: string | null } | null;
          } | null;
          parentElement: {
            querySelector: (s: string) => { textContent: string | null } | null;
          } | null;
        }) => {
          const root =
            el.closest(".application-field") ??
            el.closest("label") ??
            el.parentElement;
          const selected =
            root?.querySelector?.("[class*='selected']") ??
            root?.querySelector?.("[data-selected]");
          return (
            (selected?.textContent ??
              el.getAttribute("value") ??
              el.textContent ??
              "")
              .replace(/\s+/g, " ")
              .trim()
          );
        },
      ).catch(() => "")
    ).trim();
  }

  if (!readBack) {
    // Final keyboard Tab often forces commit in Google Places.
    await loc.focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    readBack = (await loc.inputValue().catch(() => "")).trim();
  }

  if (!readBack) {
    notes.push("location still empty after suggestion pick — will fail verify");
    throw new Error(
      `location autocomplete did not commit (typed "${text}"; tried click-first + ArrowDown/Enter). ${notes.join("; ")}`,
    );
  }

  notes.push(`location committed: ${readBack.slice(0, 120)}`);
  return { notes };
}

/** Digits only; used so ITI formatting ("(555) 123-4567") can match raw profile. */
function phoneDigits(s: string): string {
  return s.replace(/\D/g, "");
}

function phonesMatch(expected: string, observed: string): boolean {
  const e = phoneDigits(expected);
  const o = phoneDigits(observed);
  // Require a real national number fragment; refuse short codes / empty.
  if (e.length < 7 || o.length < 7) return false;
  return e === o || e.endsWith(o) || o.endsWith(e);
}

/**
 * Country name from profile vs job-boards collapse to dial-only ("+1").
 * +1 is shared by several countries — only accept US primary names for +1,
 * and unambiguous single-country dials for the rest. Never invent Canada→US.
 */
function countryDialCompatible(expected: string, observed: string): boolean {
  const dial = observed.trim();
  if (!/^\+\d{1,4}$/.test(dial)) return false;
  const name = expected
    .replace(/\s*\+\d+\s*$/u, "")
    .trim()
    .toLowerCase()
    .replace(/['']/g, "");
  if (name.length < 2) return false;

  // Unambiguous dials (single primary country on common GH job boards).
  const UNIQUE: Record<string, string[]> = {
    "+44": ["united kingdom", "uk", "great britain", "england"],
    "+91": ["india"],
    "+61": ["australia"],
    "+81": ["japan"],
    "+49": ["germany"],
    "+33": ["france"],
    "+86": ["china"],
    "+52": ["mexico"],
  };
  const unique = UNIQUE[dial];
  if (unique) {
    return unique.some((n) => name === n || name.includes(n) || n.includes(name));
  }

  // +1: US board defaults are almost always "United States +1". Canada is
  // also +1 — only accept explicit US wording, never bare "North America".
  if (dial === "+1") {
    return (
      name === "united states" ||
      name === "united states of america" ||
      name === "usa" ||
      name === "us" ||
      name.startsWith("united states")
    );
  }
  return false;
}

function valuesMatch(expected: unknown, observed: unknown): boolean {
  if (expected === observed) return true;
  const eRaw = String(expected ?? "").trim();
  const oRaw = String(observed ?? "").trim();
  if (eRaw === "" || oRaw === "") return eRaw === oRaw && eRaw !== "";
  const e = eRaw.toLowerCase();
  const o = oRaw.toLowerCase();
  if (e === o) return true;
  if (e === "yes" && ["yes", "y", "true", "1"].includes(o)) return true;
  if (e === "no" && ["no", "n", "false", "0"].includes(o)) return true;
  // Combobox displays may be truncated / dial-code-only ("United States" → "+1")
  // or taxonomy-shifted ("Bachelor of Science" → "Bachelor's Degree").
  if (labelsCompatible(eRaw, oRaw)) return true;
  if (labelsCompatible(oRaw, eRaw)) return true;
  if (pickOptionLabel([oRaw], eRaw).ok) return true;
  // Multi-select readback "Man, Woman" vs expected "Man": require exclusive match.
  if (oRaw.includes(",")) {
    const parts = oRaw.split(",").map((s) => s.trim()).filter(Boolean);
    if (
      parts.length > 0 &&
      parts.every(
        (p) =>
          labelsCompatible(eRaw, p) ||
          pickOptionLabel([p], eRaw).ok ||
          phonesMatch(eRaw, p),
      )
    ) {
      return true;
    }
  }
  // "United States" (profile) vs "+1" (collapsed country control).
  if (countryDialCompatible(eRaw, oRaw) || countryDialCompatible(oRaw, eRaw)) {
    return true;
  }
  // ITI phone formatting vs profile digits.
  if (phonesMatch(eRaw, oRaw)) return true;
  // Places commit "Baltimore, MD, USA" vs plan "Baltimore" / "Baltimore, Maryland, USA"
  if (locationsMatch(eRaw, oRaw) || locationsMatch(oRaw, eRaw)) return true;
  return false;
}

function isApprovedExecutable(
  entry: ExecutableFillEntry,
): entry is ApprovedFillPlanEntry & { approved: true; action: "FILL" } {
  return (
    "approved" in entry &&
    entry.approved === true &&
    entry.action === "FILL"
  );
}

/**
 * Fill Greenhouse fields from an approved fill plan.
 * Rejects essay/textarea/demographic/unapproved entries even if present.
 * Call assertFormFillAllowed first. Does not click submit.
 */
export async function greenhouseFillFromPlan(
  page: Page,
  entries: ExecutableFillEntry[],
  fieldMeta: Map<string, FieldMeta>,
): Promise<FillResult> {
  assertFormFillAllowed("greenhouse.fill");
  const filled: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];
  const field_meta: FieldFillMeta[] = [];

  for (const entry of entries) {
    if (!isApprovedExecutable(entry)) {
      if (
        entry.action === "fill" ||
        entry.action === "FILL" ||
        ("approved" in entry && entry.approved)
      ) {
        errors.push(
          `${entry.field_id}: rejected — entry is not an approved FILL action`,
        );
      } else {
        skipped.push(entry.field_id);
      }
      continue;
    }

    try {
      assertExecutableApprovedEntry(entry);
      if (entry.type === "textarea") {
        throw new Error("textarea/essay never filled");
      }
      // Demographics only when approved via sensitive-profile values
      // (assertExecutableApprovedEntry already gates the allowlist).
    } catch (err) {
      errors.push(
        `${entry.field_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    const meta = fieldMeta.get(entry.field_id);
    try {
      const loc = locatorForField(page, {
        field_id: entry.field_id,
        label: entry.label,
        ...(meta?.name ? { name: meta.name } : {}),
        ...(meta?.inputId ? { inputId: meta.inputId } : {}),
      });
      const type = meta?.type ?? entry.type;
      if (type === "select") {
        // Offline discovery types both native selects and React-select
        // comboboxes as "select"; only the live element tells them apart.
        const kind = await detectControlKind(loc);
        if (kind === "native_select") {
          await setSelectByValueOrLabel(loc, entry.value);
          field_meta.push({
            field_id: entry.field_id,
            canonical_field: entry.canonical_field,
            control_kind: "native_select",
            selected_option: String(entry.value),
            match_via: "exact",
          });
        } else {
          const result = await fillComboboxControl(page, loc, entry.value);
          field_meta.push({
            field_id: entry.field_id,
            canonical_field: entry.canonical_field,
            control_kind: "combobox",
            selected_option: result.selectedLabel,
            match_via: result.pickVia ?? null,
            notes: result.notes,
            ...(result.optionsSample
              ? { options_sample: result.optionsSample }
              : {}),
          });
          if (!result.committed) {
            throw new Error(
              `combobox option not committed: ${result.notes.join("; ")}`,
            );
          }
        }
      } else if (type === "checkbox") {
        const on = Boolean(entry.value) && entry.value !== "No";
        if (on) await loc.check();
        else await loc.uncheck();
        field_meta.push({
          field_id: entry.field_id,
          canonical_field: entry.canonical_field,
          control_kind: "text",
        });
      } else if (type === "radio") {
        const name = meta?.name;
        const group = name
          ? page.locator(`[name="${name.replace(/"/g, '\\"')}"]`)
          : page.locator('input[type="radio"]');
        const wanted = String(entry.value).toLowerCase();
        const count = await group.count();
        let matched = false;
        for (let i = 0; i < count; i++) {
          const opt = group.nth(i);
          const val = ((await opt.getAttribute("value")) ?? "").toLowerCase();
          const labelText = await opt.evaluate(
            (el: {
              getAttribute: (name: string) => string | null;
              parentElement?: { textContent?: string | null } | null;
            }) => {
              const id = el.getAttribute("id");
              if (id) {
                // document is available in the browser runtime only
                const doc = (
                  globalThis as unknown as {
                    document?: {
                      querySelector: (s: string) => { textContent?: string | null } | null;
                    };
                  }
                ).document;
                const lab = doc?.querySelector(`label[for="${id}"]`);
                if (lab?.textContent) return lab.textContent.trim();
              }
              return el.parentElement?.textContent?.trim() ?? "";
            },
          );
          if (val === wanted || labelText.toLowerCase().includes(wanted)) {
            await opt.check();
            matched = true;
            break;
          }
        }
        if (!matched) {
          throw new Error(`No radio option for "${entry.value}"`);
        }
        field_meta.push({
          field_id: entry.field_id,
          canonical_field: entry.canonical_field,
          control_kind: "text",
        });
      } else {
        // Text-typed entries can still be combobox inner inputs live
        // (discovery saw <input>, the widget is a React-select).
        const kind = await detectControlKind(loc);
        if (kind === "combobox") {
          const result = await fillComboboxControl(page, loc, entry.value);
          field_meta.push({
            field_id: entry.field_id,
            canonical_field: entry.canonical_field,
            control_kind: "combobox",
            selected_option: result.selectedLabel,
            match_via: result.pickVia ?? null,
            notes: result.notes,
            ...(result.optionsSample
              ? { options_sample: result.optionsSample }
              : {}),
          });
          if (!result.committed) {
            throw new Error(
              `combobox option not committed: ${result.notes.join("; ")}`,
            );
          }
        } else if (kind === "native_select") {
          await setSelectByValueOrLabel(loc, entry.value);
          field_meta.push({
            field_id: entry.field_id,
            canonical_field: entry.canonical_field,
            control_kind: "native_select",
            selected_option: String(entry.value),
            match_via: "exact",
          });
        } else {
          if (
            isLocationStyleField({
              field_id: entry.field_id,
              label: entry.label,
              canonical_field: entry.canonical_field,
              ...(meta?.name ? { name: meta.name } : {}),
              ...(meta?.inputId ? { inputId: meta.inputId } : {}),
            })
          ) {
            const locFill = await fillLocationStyleText(page, loc, entry.value);
            field_meta.push({
              field_id: entry.field_id,
              canonical_field: entry.canonical_field,
              control_kind: "text",
              notes: locFill.notes,
            });
          } else {
            await loc.fill(String(entry.value));
            field_meta.push({
              field_id: entry.field_id,
              canonical_field: entry.canonical_field,
              control_kind: "text",
            });
          }
        }
      }
      filled.push(entry.canonical_field ?? entry.field_id);
    } catch (err) {
      errors.push(
        `${entry.field_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { filled, skipped, errors, field_meta };
}

export async function greenhouseReadFieldValue(
  page: Page,
  entry: FillPlanEntry & { name?: string; inputId?: string },
): Promise<unknown> {
  const loc = locatorForField(page, entry);
  const tag = await loc.evaluate((el: { tagName: string }) =>
    el.tagName.toLowerCase(),
  );
  if (tag === "select") {
    const value = await loc.inputValue();
    const label = await loc.evaluate(
      (el: {
        selectedOptions?: ArrayLike<{ textContent?: string | null }>;
      }) => {
        const opt = el.selectedOptions?.[0];
        return opt?.textContent?.trim() ?? "";
      },
    );
    return { value, label };
  }
  const type = await loc.getAttribute("type");
  if (type === "checkbox" || type === "radio") {
    return loc.isChecked();
  }
  // Combobox inner inputs: inputValue() is the transient filter text and
  // LIES about commitment — read the committed display instead, null while
  // the placeholder shows. A half-open menu now verifies false.
  const kind = await detectControlKind(loc);
  if (kind === "combobox") {
    const committed = await readComboboxValue(loc);
    return { value: committed ?? "", label: committed ?? "" };
  }
  return loc.inputValue();
}

export async function greenhouseVerifyFromPlan(
  page: Page,
  entries: ExecutableFillEntry[],
  fieldMeta: Map<string, FieldMeta>,
): Promise<FormVerificationResult> {
  const fields: FormVerificationResult["fields"] = [];
  const warnings: string[] = [];

  const fillable = entries.filter(
    (e) =>
      (e.action === "fill" || e.action === "FILL") &&
      (!("approved" in e) || e.approved === true),
  );

  for (const entry of fillable) {
    const meta = fieldMeta.get(entry.field_id);
    const canonical = entry.canonical_field ?? entry.field_id;
    try {
      const observed = await greenhouseReadFieldValue(page, {
        field_id: entry.field_id,
        label: entry.label,
        type: entry.type,
        canonical_field: entry.canonical_field,
        action: "fill",
        value: entry.value,
        reason: "verify",
        ...(meta?.name ? { name: meta.name } : {}),
        ...(meta?.inputId ? { inputId: meta.inputId } : {}),
      });
      const expected = entry.value;
      let match = false;
      if (
        observed &&
        typeof observed === "object" &&
        "value" in observed &&
        "label" in observed
      ) {
        const o = observed as { value: unknown; label: unknown };
        match =
          valuesMatch(expected, o.value) || valuesMatch(expected, o.label);
      } else {
        match = valuesMatch(expected, observed);
      }
      fields.push({
        canonical_field: canonical,
        expected,
        observed,
        match,
      });
    } catch (err) {
      warnings.push(
        `verify ${canonical}: ${err instanceof Error ? err.message : String(err)}`,
      );
      fields.push({
        canonical_field: canonical,
        expected: entry.value,
        observed: null,
        match: false,
      });
    }
  }

  return {
    passed:
      fields.length > 0 && fields.every((f) => f.match) && warnings.length === 0,
    fields,
    uploads: [],
    warnings,
  };
}

/**
 * Resolve the file input on job-boards / classic Greenhouse forms.
 * Prefer id-based inputs (job-boards has no name=). Search all frames.
 * Hidden / visually-hidden is OK — setInputFiles only needs attached.
 */
export async function resolveGreenhouseFileInput(
  page: Page,
  kind: "resume" | "cover_letter",
): Promise<Locator> {
  const preferId = kind === "resume" ? "resume" : "cover_letter";
  const keywords =
    kind === "resume" ? (["resume", "cv"] as const) : (["cover"] as const);

  // Prefer main frame + id (job-boards: #resume / #cover_letter, no name=).
  // Use short-lived waits; callers re-resolve immediately before mutate.
  const main = page.mainFrame();
  const frames = [main, ...page.frames().filter((f) => f !== main)];

  for (const frame of frames) {
    const byId = frame.locator(`input[type="file"]#${preferId}`);
    if ((await byId.count().catch(() => 0)) > 0) {
      await byId.first().waitFor({ state: "attached", timeout: 5_000 });
      return byId.first();
    }

    for (const kw of keywords) {
      const byAttr = frame.locator(
        `input[type="file"][name*="${kw}" i], input[type="file"][id*="${kw}" i]`,
      );
      if ((await byAttr.count().catch(() => 0)) > 0) {
        await byAttr.first().waitFor({ state: "attached", timeout: 5_000 });
        return byAttr.first();
      }
    }
  }

  // Fall back: index among form file inputs (job-boards: resume then cover).
  for (const frame of frames) {
    const files = frame.locator("input[type='file']");
    const n = await files.count().catch(() => 0);
    if (n === 0) continue;
    for (let i = 0; i < n; i++) {
      const loc = files.nth(i);
      const id = ((await loc.getAttribute("id")) ?? "").toLowerCase();
      const name = ((await loc.getAttribute("name")) ?? "").toLowerCase();
      const looksCover = /cover/.test(id) || /cover/.test(name);
      const looksResume =
        /resume|cv/.test(id) || /resume|cv/.test(name) || (!looksCover && i === 0);
      if (kind === "resume" && looksResume && !looksCover) {
        await loc.waitFor({ state: "attached", timeout: 5_000 });
        return loc;
      }
      if (kind === "cover_letter" && (looksCover || i === 1)) {
        await loc.waitFor({ state: "attached", timeout: 5_000 });
        return loc;
      }
    }
  }

  const inventory = await inventoryFileInputs(page);
  throw new Error(
    `Greenhouse ${kind} file input not found (waited for attached). ` +
      `Saw ${inventory.length} input[type=file]: ${JSON.stringify(inventory)}`,
  );
}

async function inventoryFileInputs(
  page: Page,
): Promise<Array<{ frame: string; id: string | null; name: string | null }>> {
  const out: Array<{ frame: string; id: string | null; name: string | null }> =
    [];
  for (const frame of page.frames()) {
    const handles = frame.locator("input[type='file']");
    const n = await handles.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const h = handles.nth(i);
      out.push({
        frame: frame.url(),
        id: await h.getAttribute("id"),
        name: await h.getAttribute("name"),
      });
    }
  }
  return out;
}

export async function greenhouseUploadFile(
  page: Page,
  kind: "resume" | "cover_letter",
  filePath: string,
): Promise<UploadVerification> {
  assertFormFillAllowed(`greenhouse.upload.${kind}`);
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    return {
      field: kind,
      path: abs,
      filename: path.basename(abs),
      size_bytes: 0,
      verified: false,
      evidence: "file missing",
    };
  }
  const stat = fs.statSync(abs);
  logger.info(`greenhouse upload: resolving ${kind} input`, {
    service: "greenhouse",
    action: "upload",
    metadata: { kind, size_bytes: stat.size },
  });

  // Escape open menus before upload. Job-boards unmounts #resume after a
  // successful setInputFiles and shows a filename chip — verify must treat
  // that pattern as success, not re-resolve fail.
  const filename = path.basename(abs);
  const preferId = kind === "resume" ? "resume" : "cover_letter";
  try {
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(100);

    const input = await resolveGreenhouseFileInput(page, kind);
    // Hidden / visually-hidden is intentional — do not click "Attach" (OS dialog).
    await input.setInputFiles(abs, { timeout: 15_000 });

    // Same locator, immediately — element may already be mid-unmount.
    let files: Array<{ name: string; size: number }> = [];
    try {
      files = await input.evaluate(
        (el: { files?: ArrayLike<{ name: string; size: number }> | null }) => {
          const list = el.files ? Array.from(el.files) : [];
          return list.map((f) => ({ name: f.name, size: f.size }));
        },
        { timeout: 2_000 },
      );
    } catch {
      files = [];
    }

    const inputFilesMatch =
      files.some((f) => f.name === filename) ||
      files.some((f) => f.size === stat.size);

    await page.waitForTimeout(350);
    const stillAttached =
      (await page
        .locator(`input[type="file"]#${preferId}`)
        .count()
        .catch(() => 0)) > 0;

    const stem = filename.replace(/\.[^.]+$/, "");
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const chipVisible =
      bodyText.includes(filename) ||
      (stem.length >= 12 && bodyText.includes(stem.slice(0, 24)));

    // setInputFiles threw above if it failed. On GH job-boards, success often
    // unmounts the input and shows a chip; either signal is enough.
    const ok =
      inputFilesMatch || chipVisible || (!stillAttached && files.length === 0);

    logger.info(`greenhouse upload: ${kind} complete`, {
      service: "greenhouse",
      action: "upload",
      metadata: {
        verified: ok,
        file_count: files.length,
        still_attached: stillAttached,
        chip_visible: chipVisible,
      },
    });
    return {
      field: kind,
      path: abs,
      filename,
      size_bytes: stat.size,
      verified: ok,
      evidence: `input files: ${JSON.stringify(files)}; stillAttached=${stillAttached}; chip=${chipVisible}`,
    };
  } catch (err) {
    const inventory = await inventoryFileInputs(page).catch(() => []);
    logger.info(`greenhouse upload: ${kind} failed`, {
      service: "greenhouse",
      action: "upload",
      metadata: {
        error: err instanceof Error ? err.message : String(err),
        inventory,
      },
    });
    return {
      field: kind,
      path: abs,
      filename,
      size_bytes: stat.size,
      verified: false,
      evidence: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function greenhouseResetForm(page: Page): Promise<FormResetResult> {
  assertFormFillAllowed("greenhouse.resetForm");
  const form = page.locator(greenhouseSelectorsV1.form).first();
  if ((await form.count()) === 0) {
    return { reset: false, notes: ["application form not found"] };
  }
  await form.evaluate((el: { reset: () => void }) => {
    el.reset();
  });
  return { reset: true, notes: ["HTMLFormElement.reset() invoked"] };
}

export async function greenhouseVerifyAnswers(
  page: Page,
  expected: ResolvedApplicationAnswers,
  entries: ExecutableFillEntry[],
  fieldMeta: Map<string, FieldMeta>,
): Promise<FormVerificationResult> {
  const filtered = entries.filter(
    (e) =>
      (e.action === "fill" || e.action === "FILL") &&
      (!("approved" in e) || e.approved === true) &&
      e.canonical_field &&
      expected[e.canonical_field] !== undefined,
  );
  return greenhouseVerifyFromPlan(page, filtered, fieldMeta);
}
