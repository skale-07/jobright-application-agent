import type { Locator } from "playwright";
import { pickOptionLabel } from "../greenhouse/comboboxFill.js";
import { ashbySelectorsV1 } from "./selectors.js";

/**
 * Ashby renders Yes/No questions as segmented button groups
 * (role=radiogroup holding <button> children, selection carried in
 * aria-pressed). Same contract as comboboxFill: options are collected from
 * the real DOM, matching goes through pickOptionLabel (no invented values,
 * ambiguous → refuse), and commitment is confirmed by an independent
 * read-back of the pressed state — a click that didn't stick reports
 * committed:false instead of trusting the click.
 */

export type ButtonGroupFillResult = {
  committed: boolean;
  selectedLabel: string | null;
  notes: string[];
};

export async function detectButtonGroup(loc: Locator): Promise<boolean> {
  try {
    return await loc.evaluate(
      (el: {
        getAttribute: (n: string) => string | null;
        closest: (s: string) => unknown;
      }) =>
        el.getAttribute("role") === "radiogroup" ||
        el.closest('[role="radiogroup"]') !== null,
    );
  } catch {
    return false;
  }
}

/** Text of the pressed button, or null while nothing is selected. */
export async function readButtonGroupValue(
  groupLoc: Locator,
): Promise<string | null> {
  const pressed = groupLoc.locator(ashbySelectorsV1.buttonGroup.pressed);
  if ((await pressed.count()) === 0) return null;
  const text = (await pressed.first().textContent()) ?? "";
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned === "" ? null : cleaned;
}

export async function fillButtonGroup(
  groupLoc: Locator,
  expected: unknown,
): Promise<ButtonGroupFillResult> {
  const notes: string[] = [];
  const expectedText = String(expected);

  const options = (await groupLoc.locator("button").allTextContents())
    .map((t) => t.replace(/\s+/g, " ").trim())
    .filter((t) => t.length > 0);
  if (options.length === 0) {
    notes.push("button group has no options");
    return { committed: false, selectedLabel: null, notes };
  }

  const pick = pickOptionLabel(options, expectedText);
  if (!pick.ok) {
    notes.push(pick.reason);
    return { committed: false, selectedLabel: null, notes };
  }

  await groupLoc
    .getByRole("button", { name: pick.label, exact: true })
    .first()
    .click({ timeout: 5_000 });
  notes.push(`clicked "${pick.label}" (${pick.via})`);

  const observed = await readButtonGroupValue(groupLoc);
  const committed = observed !== null && observed === pick.label;
  if (!committed) {
    notes.push(
      `commit not confirmed: pressed state shows ${observed === null ? "nothing" : `"${observed}"`}`,
    );
  }
  return { committed, selectedLabel: observed, notes };
}
