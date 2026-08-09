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
 *   - native controls count only via [required]/[aria-required];
 *   - ARIA widget groups (role=radiogroup/combobox) additionally count
 *     when their visible label ends in the universal required marker
 *     ("*" / "✱") — the live Cohere form marks required radio groups ONLY
 *     that way, and the first scan sailed past them. The failure mode of
 *     this heuristic is a visible refusal + review item, never a wrong
 *     submit, so the asymmetry favors including it;
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

  // Widget labels often live on a sibling <label> inside the field
  // container rather than on the widget itself (Ashby's live shape).
  const widgetLabel = (el) => {
    const direct = labelFor(el);
    if (direct !== "(unlabeled)") return direct;
    let node = el;
    for (let i = 0; i < 3 && node.parentElement; i++) {
      node = node.parentElement;
      const labs = node.querySelectorAll("label");
      // Exactly one label in the ancestor = unambiguous; more than one
      // means we've climbed out of this field's container — stop rather
      // than borrow a neighboring question's label (and its asterisk).
      if (labs.length === 1 && clean(labs[0].textContent)) {
        return clean(labs[0].textContent);
      }
      if (labs.length > 1) break;
    }
    return "(unlabeled)";
  };
  // aria-required is authoritative; a trailing asterisk on the label is
  // the fallback marker (the live Cohere required groups carry ONLY it).
  const widgetRequired = (el, label) =>
    el.getAttribute("aria-required") === "true" || /[*\\u2731]\\s*$/.test(label);

  const widgets = document.querySelectorAll('[role="radiogroup"], [role="combobox"]');
  for (const el of Array.from(widgets)) {
    if (!visible(el)) continue;
    const label = widgetLabel(el);
    if (!widgetRequired(el, label)) continue;
    if (el.getAttribute("role") === "radiogroup") {
      const checked = el.querySelector('[role="radio"][aria-checked="true"]');
      const nativeChecked = el.querySelector("input:checked");
      const pressed = el.querySelector('button[aria-pressed="true"]');
      if (!checked && !nativeChecked && !pressed) {
        if (!seenGroups.has(label)) {
          seenGroups.add(label);
          out.push({ label: label, control: "radio_group" });
        }
      }
    } else {
      const value = el.value || el.getAttribute("aria-valuetext") || el.textContent || "";
      const trimmed = clean(value);
      const placeholderish = /^(start typing|select|choose)/i.test(trimmed);
      if (trimmed === "" || placeholderish) {
        out.push({ label: label, control: "combobox" });
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
