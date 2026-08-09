import type { DiscoveredField } from "../adapter.js";
import { discoverFieldsFromHtml } from "../../applications/fieldDiscovery.js";
import { ashbySelectorsV1 } from "./selectors.js";

/**
 * Ashby discovery = the generic input/textarea/select pass PLUS a
 * button-group pass: Ashby renders Yes/No questions as role="radiogroup"
 * containers holding <button> children, which the generic regex discovery
 * cannot see. Emitted as type "radio" so they flow through the existing
 * plan/approval policy (demographics and essays still route away).
 */

/**
 * True when the HTML looks like Ashby's unrendered SPA shell — a root div
 * plus scripts, no form controls. Static fetches of jobs.ashbyhq.com pages
 * look like this; discovery needs a rendered DOM snapshot instead.
 */
export function looksLikeUnrenderedShell(html: string): boolean {
  const hasControls = /<(input|select|textarea|form)\b/i.test(html);
  if (hasControls) return false;
  return ashbySelectorsV1.shellMarkers.test(html);
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function getAttr(attrs: string, name: string): string | null {
  const re = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i");
  const m = attrs.match(re);
  return m?.[1] ?? null;
}

function resolveLabelledBy(html: string, id: string): string | null {
  const re = new RegExp(
    `<[^>]*\\bid=["']${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>([\\s\\S]*?)<`,
    "i",
  );
  const m = html.match(re);
  const text = m?.[1] !== undefined ? stripTags(m[1]) : "";
  return text || null;
}

/**
 * Regex pass over role="radiogroup" blocks. The original version assumed
 * button-only innards and truncated at the first nested </div> — the live
 * Cohere run proved both wrong: its Additional Questions radiogroups nest
 * divs and render options as role="radio" elements, so the groups were
 * dropped from discovery entirely and the screener bank never saw them.
 * The window now extends to the next radiogroup (or a bounded cap), and
 * options come from <button>s, [role="radio"] elements, or radio-input
 * labels — whichever the DOM actually uses.
 */
const GROUP_WINDOW_CAP = 4_000;

/**
 * True innards of the element opened at `start`: walk open/close tags of
 * the same name, balancing depth. Falls back to the cap on malformed HTML
 * — a too-wide window only risks extra option candidates, never a miss.
 */
function balancedInner(html: string, tag: string, start: number): string {
  const tokenRe = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  tokenRe.lastIndex = start;
  let depth = 1;
  let t: RegExpExecArray | null;
  while ((t = tokenRe.exec(html)) !== null) {
    depth += t[1] === "/" ? -1 : 1;
    if (depth === 0) return html.slice(start, t.index);
    if (t.index - start > GROUP_WINDOW_CAP) break;
  }
  return html.slice(start, Math.min(html.length, start + GROUP_WINDOW_CAP));
}

export function discoverAshbyButtonGroups(html: string): DiscoveredField[] {
  const out: DiscoveredField[] = [];
  const openRe = /<(div|fieldset)\b([^>]*\brole=["']radiogroup["'][^>]*)>/gi;
  const opens: Array<{ tag: string; attrs: string; start: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(html)) !== null) {
    opens.push({
      tag: m[1] ?? "div",
      attrs: m[2] ?? "",
      start: m.index + m[0].length,
    });
  }
  let idx = 0;
  for (const open of opens) {
    const attrs = open.attrs;
    const inner = balancedInner(html, open.tag, open.start);

    const options: string[] = [];
    const push = (t: string): void => {
      const clean = stripTags(t).replace(/\s+/g, " ").trim();
      if (clean && !options.includes(clean) && options.length < 12) {
        options.push(clean);
      }
    };
    // Tier 1: segmented-control buttons (the original Ashby shape).
    const btnRe = /<button\b[^>]*>([\s\S]*?)<\/button>/gi;
    let b: RegExpExecArray | null;
    while ((b = btnRe.exec(inner)) !== null) push(b[1] ?? "");
    // Tier 2: ARIA radios (the live Cohere shape).
    if (options.length === 0) {
      const radioRe =
        /<[a-z]+\b[^>]*\brole=["']radio["'][^>]*>([\s\S]*?)<\/[a-z]+>/gi;
      let r: RegExpExecArray | null;
      while ((r = radioRe.exec(inner)) !== null) push(r[1] ?? "");
    }
    // Tier 3: native radio inputs — option text from the wrapping label.
    if (options.length === 0) {
      const labelRe = /<label\b[^>]*>([\s\S]*?)<\/label>/gi;
      let l: RegExpExecArray | null;
      while ((l = labelRe.exec(inner)) !== null) {
        if (/<input\b[^>]*type=["']radio["']/i.test(l[1] ?? "")) push(l[1] ?? "");
      }
    }
    if (options.length === 0) continue;

    const fieldId = getAttr(attrs, "data-field-id") ?? undefined;
    const ariaLabel = getAttr(attrs, "aria-label") ?? undefined;
    const labelledBy = getAttr(attrs, "aria-labelledby");
    const rawLabel =
      ariaLabel ??
      (labelledBy ? (resolveLabelledBy(html, labelledBy) ?? undefined) : undefined) ??
      fieldId ??
      `button_group_${idx}`;
    // Same required-asterisk cleanup as the generic discovery's cleanLabel.
    const label = rawLabel.replace(/\s*\*\s*$/, "").replace(/\s+/g, " ").trim();
    const required = /aria-required=["']true["']/i.test(attrs);

    const field: DiscoveredField = {
      id: fieldId ?? `button_group_${idx}`,
      label,
      type: "radio",
      required,
      options,
    };
    if (fieldId) field.name = fieldId;
    out.push(field);
    idx++;
  }
  return out;
}

export function ashbyDiscoverFields(html: string): DiscoveredField[] {
  return [
    ...discoverFieldsFromHtml(html),
    ...discoverAshbyButtonGroups(html),
  ];
}
