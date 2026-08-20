import type { Page } from "playwright";
import { jobrightExtensionSelectorsV1 } from "./selectors.js";

/**
 * Activate the JobRight extension's autofill on an ATS page (X2). The
 * ONLY controls this module clicks are the registry's promoted trigger
 * selectors — the list ships empty, so until an operator ext-capture
 * promotes real selectors this function reports attempted:false and the
 * fill proceeds natively (fail closed, never a blind click).
 *
 * Settle detection is evidence-based: poll a fingerprint of the form's
 * values until it changes once and then holds stable, bounded hard by
 * settleMs. Raw values never leave the page — the fingerprint is
 * computed browser-side.
 */
export type ExtensionActivationResult = {
  attempted: boolean;
  activated: boolean;
  trigger: string | null;
  /** Polls observed / value changes seen — activation evidence. */
  changed_fields: number;
  notes: string[];
};

const VALUES_FINGERPRINT_FN = `() => {
  let hash = 5381;
  let nonEmpty = 0;
  const push = (s) => {
    for (let i = 0; i < s.length; i += 1) hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  };
  for (const el of Array.from(document.querySelectorAll("input, textarea, select"))) {
    let v = "";
    if (el.type === "checkbox" || el.type === "radio") v = el.checked ? "1" : "";
    else v = el.value || "";
    if (v !== "") nonEmpty += 1;
    push((el.id || el.name || "?") + "=" + v + ";");
  }
  return { hash, nonEmpty };
}`;

async function valuesFingerprint(
  page: Page,
): Promise<{ hash: number; nonEmpty: number }> {
  return (await page.evaluate(`(${VALUES_FINGERPRINT_FN})()`)) as {
    hash: number;
    nonEmpty: number;
  };
}

const MAX_TRIGGER_CLICKS = 2;

export async function attemptExtensionAutofill(
  page: Page,
  opts?: {
    triggerSelectors?: string[];
    settleMs?: number;
    pollMs?: number;
  },
): Promise<ExtensionActivationResult> {
  const selectors =
    opts?.triggerSelectors ?? jobrightExtensionSelectorsV1.autofillTrigger;
  const settleMs = opts?.settleMs ?? 20_000;
  const pollMs = opts?.pollMs ?? 1_000;
  const result: ExtensionActivationResult = {
    attempted: false,
    activated: false,
    trigger: null,
    changed_fields: 0,
    notes: [],
  };
  if (selectors.length === 0) {
    result.notes.push(
      "no promoted autofill-trigger selectors — run jobright:ext-capture and promote into src/jobright/extension/selectors.ts",
    );
    return result;
  }

  const before = await valuesFingerprint(page).catch(() => null);
  if (!before) {
    result.notes.push("could not fingerprint the form — activation skipped");
    return result;
  }

  let clicks = 0;
  for (const sel of selectors) {
    if (clicks >= MAX_TRIGGER_CLICKS) break;
    const locator = page.locator(sel).first();
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) continue;
    clicks += 1;
    const clicked = await locator
      .click({ timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    if (!clicked) {
      result.notes.push(`trigger click failed: ${sel}`);
      continue;
    }
    result.attempted = true;
    result.trigger = sel;

    // Bounded settle: wait for the fingerprint to change, then to hold
    // stable for two consecutive polls.
    const deadline = Date.now() + settleMs;
    let last = before;
    let changedAt: number | null = null;
    let stablePolls = 0;
    while (Date.now() < deadline) {
      await page.waitForTimeout(pollMs);
      const now = await valuesFingerprint(page).catch(() => null);
      if (!now) break;
      if (now.hash !== last.hash) {
        changedAt = Date.now();
        stablePolls = 0;
      } else if (changedAt !== null) {
        stablePolls += 1;
        if (stablePolls >= 2) break;
      }
      last = now;
    }
    if (changedAt !== null) {
      result.activated = true;
      result.changed_fields = Math.max(0, last.nonEmpty - before.nonEmpty);
      result.notes.push(
        `extension fill settled: ${result.changed_fields} field(s) newly non-empty`,
      );
      return result;
    }
    result.notes.push(
      `trigger ${sel} clicked but no form value changed within ${settleMs}ms`,
    );
  }
  if (!result.attempted) {
    result.notes.push("no promoted trigger selector was visible on the page");
  }
  return result;
}
