import type { Locator, Page } from "playwright";
import { pickOptionLabel } from "../greenhouse/comboboxFill.js";
import { ashbySelectorsV1 } from "./selectors.js";

/**
 * Ashby combobox commit + read-back. The greenhouse combobox reader keys on
 * React-select shells ("select__control"/"select-shell") and single-value
 * nodes; Ashby renders the committed choice into a sibling display node
 * (span[class*="__selected"] / [data-selected-label]) inside a plain
 * ".ashby-select" container, which that reader cannot see — so commitment
 * and read-back live here, against ashbySelectorsV1. Matching still goes
 * through greenhouse's pickOptionLabel so synonym policy stays uniform
 * across ATSes. Same honesty contract as every fill path: no match → no
 * click, no residue; commitment is confirmed by an independent read of the
 * committed display node, never by trusting the click.
 */

export type AshbyComboboxFillResult = {
  committed: boolean;
  selectedLabel: string | null;
  notes: string[];
};

/** Committed display text, or null while the placeholder is showing. */
export async function readAshbyComboboxValue(
  loc: Locator,
): Promise<string | null> {
  type El = {
    closest: (s: string) => El | null;
    parentElement: El | null;
    querySelector: (s: string) => { textContent: string | null } | null;
  };
  const raw = await loc.evaluate((el: El) => {
    const shell = el.closest('[class*="select"]') ?? el.parentElement;
    if (!shell) return null;
    const node = shell.querySelector(
      '[class*="__selected"], [data-selected-label]',
    );
    return node?.textContent ?? null;
  });
  if (raw === null) return null;
  const text = raw.replace(/\s+/g, " ").trim();
  if (text === "" || ashbySelectorsV1.combobox.placeholder.test(text)) {
    return null;
  }
  return text;
}

export async function fillAshbyCombobox(
  page: Page,
  loc: Locator,
  expected: unknown,
): Promise<AshbyComboboxFillResult> {
  const notes: string[] = [];
  const expectedText = String(expected);

  await loc.click({ timeout: 10_000 });
  const listbox = page
    .locator(ashbySelectorsV1.combobox.listbox)
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
        .locator(ashbySelectorsV1.combobox.option)
        .filter({ visible: true })
        .allTextContents()
    )
      .map((t) => t.replace(/\s+/g, " ").trim())
      .filter((t) => t.length > 0);

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
    // Close without committing — no invented values, no filter residue.
    await page.keyboard.press("Escape").catch(() => undefined);
    await loc.fill("", { timeout: 1_500 }).catch(() => undefined);
    return { committed: false, selectedLabel: null, notes };
  }

  const option = page
    .locator(ashbySelectorsV1.combobox.option)
    .filter({ visible: true })
    .filter({ hasText: pick.label })
    .first();
  await option.click({ timeout: 5_000 });
  notes.push(`picked "${pick.label}" (${pick.via})`);

  await listbox
    .waitFor({ state: "hidden", timeout: 5_000 })
    .catch(() => notes.push("listbox still visible after pick"));
  await page.waitForTimeout(200);

  const committedLabel = await readAshbyComboboxValue(loc);
  const committed =
    committedLabel !== null &&
    committedLabel.toLowerCase().includes(pick.label.toLowerCase().slice(0, 40));
  if (!committed) {
    notes.push(
      `commit not confirmed: display shows ${committedLabel === null ? "placeholder" : `"${committedLabel}"`}`,
    );
  }
  return { committed, selectedLabel: committedLabel, notes };
}
