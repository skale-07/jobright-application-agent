/**
 * Required-completeness scan — the pre-click gate the run data demanded.
 * The real Cohere attempt clicked Submit with every required "Additional
 * Question" untouched: the click bounced off client-side validation, the
 * form stayed up, and the run ended UNCERTAIN(still_on_form) — review
 * noise instead of a precise answer. This scan reads the live page for
 * required-but-unanswered controls immediately before the click; any hit
 * refuses the submit BEFORE the click (no budget spent, thanks to the
 * click-commit gate) and names each unanswered question.
 *
 * Conservative in both directions:
 *   - only [required]/[aria-required] controls count — no heuristics on
 *     asterisks or styling, so an optional field can never block;
 *   - fail-open on scan errors — a broken scan must not strand a
 *     completed form (post-click verification still guards the outcome).
 *
 * The page-side code ships as a string expression: src/ compiles without
 * DOM libs, and Playwright evaluates the string in the browser context.
 */
import type { Page } from "playwright";

export type UnansweredRequired = {
  label: string;
  control: "text" | "textarea" | "select" | "radio_group" | "checkbox" | "combobox";
};

export type CompletenessScan = {
  scanned: boolean;
  unanswered: UnansweredRequired[];
  notes: string[];
};

const SCAN_EXPRESSION = `(() => {
  const out = [];
  const seenGroups = new Set();

  const visible = (el) => {
    if (!el.offsetParent && getComputedStyle(el).position !== "fixed") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const clean = (t) => (t || "").replace(/\\s+/g, " ").trim().slice(0, 120);

  const labelFor = (el) => {
    let byId = null;
    if (el.id) {
      byId = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
    }
    const ariaIds = el.getAttribute("aria-labelledby");
    const ariaEl = ariaIds ? document.getElementById(ariaIds.split(/\\s+/)[0] || "") : null;
    const wrapped = el.closest("label");
    const fieldset = el.closest("fieldset");
    const legend = fieldset ? fieldset.querySelector("legend") : null;
    const text =
      (byId && byId.textContent) ||
      (ariaEl && ariaEl.textContent) ||
      el.getAttribute("aria-label") ||
      (wrapped && wrapped.textContent) ||
      (legend && legend.textContent) ||
      "";
    return clean(text) || "(unlabeled)";
  };

  const isRequired = (el) =>
    el.required === true || el.getAttribute("aria-required") === "true";

  for (const el of Array.from(document.querySelectorAll("input, textarea, select"))) {
    const type = (el.type || "").toLowerCase();
    if (type === "hidden" || type === "file" || type === "submit" || type === "button") continue;
    if (!isRequired(el)) continue;

    if (type === "radio") {
      const name = el.name || "";
      const key = name || labelFor(el);
      if (seenGroups.has(key)) continue;
      seenGroups.add(key);
      const group = name
        ? Array.from(document.querySelectorAll('input[type="radio"][name="' + CSS.escape(name) + '"]'))
        : [el];
      const anyChecked = group.some((r) => r.checked);
      const anyVisible = group.some((r) => visible(r));
      if (!anyChecked && anyVisible) {
        const fs = el.closest("fieldset");
        const legend = fs ? fs.querySelector("legend") : null;
        out.push({
          label: clean(legend ? legend.textContent : labelFor(el)) || "(radio group)",
          control: "radio_group",
        });
      }
      continue;
    }
    if (!visible(el)) continue;
    if (type === "checkbox") {
      if (!el.checked) out.push({ label: labelFor(el), control: "checkbox" });
      continue;
    }
    if (el.tagName === "SELECT") {
      const placeholderish = el.selectedIndex <= 0 && (!el.value || el.value === "");
      if (placeholderish) out.push({ label: labelFor(el), control: "select" });
      continue;
    }
    if (((el.value || "") + "").trim() === "") {
      out.push({
        label: labelFor(el),
        control: el.tagName === "TEXTAREA" ? "textarea" : "text",
      });
    }
  }

  const widgets = document.querySelectorAll(
    '[role="radiogroup"][aria-required="true"], [role="combobox"][aria-required="true"]'
  );
  for (const el of Array.from(widgets)) {
    if (!visible(el)) continue;
    if (el.getAttribute("role") === "radiogroup") {
      const checked = el.querySelector('[role="radio"][aria-checked="true"]');
      const nativeChecked = el.querySelector("input:checked");
      if (!checked && !nativeChecked) {
        const key = labelFor(el);
        if (!seenGroups.has(key)) {
          seenGroups.add(key);
          out.push({ label: key, control: "radio_group" });
        }
      }
    } else {
      const value = el.value || el.getAttribute("aria-valuetext") || el.textContent || "";
      const trimmed = clean(value);
      const placeholderish = /^(start typing|select|choose)/i.test(trimmed);
      if (trimmed === "" || placeholderish) {
        out.push({ label: labelFor(el), control: "combobox" });
      }
    }
  }
  return out.slice(0, 20);
})()`;

export async function scanRequiredCompleteness(
  page: Page,
): Promise<CompletenessScan> {
  try {
    const unanswered = (await page.evaluate(SCAN_EXPRESSION)) as Array<{
      label: string;
      control: UnansweredRequired["control"];
    }>;
    const seen = new Set<string>();
    const deduped = unanswered.filter((u) => {
      const k = `${u.label}::${u.control}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return { scanned: true, unanswered: deduped, notes: [] };
  } catch (err) {
    return {
      scanned: false,
      unanswered: [],
      notes: [
        `required-completeness scan failed (fail-open): ${
          err instanceof Error ? err.message.slice(0, 150) : String(err)
        }`,
      ],
    };
  }
}
