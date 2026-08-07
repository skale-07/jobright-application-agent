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
 * Regex pass over role="radiogroup" blocks. Assumes button-only group
 * innards (true of Ashby's segmented controls; a group containing nested
 * divs would truncate at the first </div> — acceptable for the synthetic
 * fixture, revisit against captured live DOM).
 */
export function discoverAshbyButtonGroups(html: string): DiscoveredField[] {
  const out: DiscoveredField[] = [];
  const groupRe =
    /<div\b([^>]*\brole=["']radiogroup["'][^>]*)>([\s\S]*?)<\/div>/gi;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = groupRe.exec(html)) !== null) {
    const attrs = m[1] ?? "";
    const inner = m[2] ?? "";

    const options: string[] = [];
    const btnRe = /<button\b[^>]*>([\s\S]*?)<\/button>/gi;
    let b: RegExpExecArray | null;
    while ((b = btnRe.exec(inner)) !== null) {
      const t = stripTags(b[1] ?? "");
      if (t) options.push(t);
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
