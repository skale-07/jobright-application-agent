import type { DiscoveredField } from "../ats/adapter.js";

/**
 * Offline HTML field discovery — no browser required.
 * Uses regex + lightweight heuristics suitable for fixture tests and Phase 4 dry-run.
 * Prefer label[for], aria-label, placeholder, name — not brittle class chains alone.
 */
/**
 * Does this "label" actually name a question? A bracketed machine path, a
 * bare uuid, a `field_12` fallback, or generic placeholder prose all mean
 * the real question lives elsewhere in the DOM.
 */
export function isUninformativeLabel(label: string): boolean {
  const t = label.trim();
  if (t.length === 0) return true;
  if (/^field_\d+$/.test(t)) return true;
  if (/\[[^\]]*\]/.test(t)) return true; // cards[uuid][field0], urls[Other]
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) {
    return true;
  }
  if (/^(type your (response|answer)|your (answer|response)|answer|response|select(\.\.\.| an option)?|choose(\.\.\.| one)?|please select)$/i.test(t)) {
    return true;
  }
  return false;
}

// Legends and headings only. A preceding <label> belongs to a DIFFERENT
// control — this field's own label was already resolved via labelMap — so
// including it made a radio option ("Yes") look like a section heading.
const HEADING_RE =
  /<(legend|h1|h2|h3|h4|h5|h6)\b[^>]*>([\s\S]{1,300}?)<\/\1>/gi;

/**
 * Text of the nearest legend/heading/label BEFORE this position — the
 * question a machine-named control sits under. Bounded scan; returns null
 * rather than guessing when nothing informative precedes the field.
 */
export function nearestSectionHeading(
  html: string,
  position: number,
): string | null {
  const window = html.slice(Math.max(0, position - 4_000), position);
  HEADING_RE.lastIndex = 0;
  let best: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = HEADING_RE.exec(window)) !== null) {
    const text = cleanLabel(decodeEntities(stripTags(m[2] ?? "")));
    if (text.length < 3 || text.length > 200) continue;
    if (isUninformativeLabel(text)) continue;
    best = text; // last (nearest) informative one wins
  }
  return best;
}

export function discoverFieldsFromHtml(
  rawHtml: string,
  opts?: { preferGreenhouse?: boolean },
): DiscoveredField[] {
  // Regex discovery reads RAW text, so an <input …> inside a <script>
  // string literal (SPA templates, JSON payloads) counted as a real field
  // — the Workday wizard walk handed a review page to the filler because
  // the page's own script mentioned form markup. DOM-invisible blocks go
  // first.
  const html = stripHiddenSubtrees(
    rawHtml
      .replace(/<script\b[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[\s\S]*?<\/style>/gi, "")
      .replace(/<template\b[\s\S]*?<\/template>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, ""),
  );
  const fields: DiscoveredField[] = [];
  const labelMap = buildLabelMap(html);

  const inputRe =
    /<(input|textarea|select)\b([^>]*)>(?:([\s\S]*?)<\/\1>)?/gi;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = inputRe.exec(html)) !== null) {
    const tag = (m[1] ?? "input").toLowerCase();
    const attrs = m[2] ?? "";
    const inner = m[3] ?? "";

    const typeAttr = getAttr(attrs, "type")?.toLowerCase() ?? (tag === "textarea" ? "textarea" : tag === "select" ? "select" : "text");
    if (typeAttr === "hidden" || typeAttr === "submit" || typeAttr === "button" || typeAttr === "image") {
      continue;
    }

    const name = getAttr(attrs, "name") ?? undefined;
    const inputId = getAttr(attrs, "id") ?? undefined;
    const ariaLabel = getAttr(attrs, "aria-label") ?? undefined;
    const placeholder = getAttr(attrs, "placeholder") ?? undefined;
    const dataFor = getAttr(attrs, "data-for") ?? undefined;
    const required =
      /\brequired\b/i.test(attrs) ||
      /aria-required=["']true["']/i.test(attrs);

    let label =
      (inputId ? labelMap.get(inputId) : undefined) ??
      ariaLabel ??
      placeholder ??
      dataFor ??
      name ??
      `field_${idx}`;

    const fieldType = mapType(tag, typeAttr);
    const wrap = wrappingLabelTexts(html, m.index, m.index + m[0].length);
    // Spec-standard wrapping <label> with no `for`. For checkboxes/text
    // this IS the question. For radios it is usually the option ("Yes").
    if (
      fieldType !== "radio" &&
      wrap?.full &&
      (isUninformativeLabel(label) || (name !== undefined && label === name))
    ) {
      label = wrap.full;
    }

    // A machine name or a placeholder is not a question. Live corpus:
    // "cards[631785a2-…][field0]" ×13 (Lever's education/experience cards —
    // school, degree, dates: data the profile HOLDS), "Type your response"
    // ×10, "field_33". Those 72 fields were skipped as unmapped, and the
    // prediction tier rejected them as "unusable label". Look upward for
    // the nearest legend/heading instead of giving up.
    if (isUninformativeLabel(label)) {
      const nearby = nearestSectionHeading(html, m.index);
      if (nearby) label = nearby;
    }

    if (opts?.preferGreenhouse && name) {
      const greenhouseLabel = inferGreenhouseLabel(name, label);
      if (greenhouseLabel) label = greenhouseLabel;
    }

    const valueAttr = getAttr(attrs, "value");
    let options =
      tag === "select" ? parseSelectOptions(inner) : undefined;
    if (fieldType === "radio") {
      const optionText = radioOptionText({
        wrap,
        value: valueAttr,
        label,
        name,
      });
      const question =
        nearestBareQuestionLabel(html, m.index) ??
        (radioNeedsQuestionLabel(label, name)
          ? nearestSectionHeading(html, m.index)
          : null);
      if (question) label = question;
      options = [optionText];
    }

    const maxLengthRaw = getAttr(attrs, "maxlength");
    const minLengthRaw = getAttr(attrs, "minlength");

    const field: DiscoveredField = {
      id: inputId ?? name ?? `f_${idx}`,
      label: cleanLabel(label),
      type: fieldType,
      required,
    };
    if (options) field.options = options;
    if (name) field.name = name;
    if (inputId) field.inputId = inputId;
    if (maxLengthRaw) field.maxLength = Number(maxLengthRaw);
    if (minLengthRaw) field.minLength = Number(minLengthRaw);

    fields.push(field);
    idx++;
  }

  // Radio groups: collapse by name
  return collapseRadioGroups(fields);
}

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function isHiddenAttrs(attrs: string): boolean {
  if (/aria-hidden\s*=\s*["']true["']/i.test(attrs)) return true;
  if (/display\s*:\s*none/i.test(attrs)) return true;
  const withoutAria = attrs.replace(/aria-hidden\s*=\s*["'][^"']*["']/gi, "");
  return /(?:^|\s)hidden(?:\s|=|\/|$)/i.test(withoutAria);
}

function matchingCloseIndex(html: string, tag: string, from: number): number {
  const token = new RegExp(`<${tag}\\b[^>]*>|</${tag}\\s*>`, "gi");
  token.lastIndex = from;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = token.exec(html)) !== null) {
    if (m[0].startsWith("</")) depth -= 1;
    else if (!/\/\s*>$/.test(m[0])) depth += 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return -1;
}

/**
 * Wizard steps and Other-specify wraps ship in the same document with
 * `display:none`. Regex discovery otherwise plans those controls, fill
 * waits 2s for visibility, errors, and the Next walker never starts
 * (/fillhard page 2).
 */
/**
 * Consent-manager (OneTrust/Optanon) DOM is page furniture, not the
 * application. Live Paylocity 2026-08-19: 6 cookie toggles were planned as
 * application fields — including OneTrust's own hidden template
 * placeholders ("checkbox label", "Switch Label") — inflating the field
 * count that decides posting-vs-form and polluting the operator brief.
 * The whole banner subtree is dropped before discovery.
 */
function isConsentManagerAttrs(attrs: string): boolean {
  const id = getAttr(attrs, "id") ?? "";
  if (/^(onetrust|ot-sdk|optanon)/i.test(id)) return true;
  const cls = getAttr(attrs, "class") ?? "";
  if (/(^|\s)(onetrust|ot-sdk|optanon)/i.test(cls)) return true;
  return /\bdata-optanongroupid\s*=/i.test(attrs);
}

function stripHiddenSubtrees(html: string): string {
  const openRe = /<([a-z][a-z0-9]*)\b([^>]*?)>/gi;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(html)) !== null) {
    const tag = (m[1] ?? "").toLowerCase();
    const attrs = m[2] ?? "";
    if (VOID_TAGS.has(tag)) continue;
    if (!isHiddenAttrs(attrs) && !isConsentManagerAttrs(attrs)) continue;
    if (/\/\s*$/.test(attrs)) continue;
    const end = matchingCloseIndex(html, tag, m.index + m[0].length);
    if (end < 0) continue;
    out += html.slice(last, m.index);
    last = end;
    openRe.lastIndex = end;
  }
  return out + html.slice(last);
}

function buildLabelMap(html: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /<label\b([^>]*)>([\s\S]*?)<\/label>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] ?? "";
    const body = stripTags(m[2] ?? "").trim();
    const forId = getAttr(attrs, "for");
    if (forId && body) map.set(forId, body);
  }
  return map;
}

function getAttr(attrs: string, name: string): string | null {
  const re = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i");
  const m = attrs.match(re);
  return m?.[1] ?? null;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function cleanLabel(s: string): string {
  return s.replace(/\s*\*\s*$/, "").replace(/\s+/g, " ").trim();
}

/** Headings carry entities that a question text must not; decode the common ones. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function mapType(
  tag: string,
  typeAttr: string,
): DiscoveredField["type"] {
  if (tag === "textarea") return "textarea";
  if (tag === "select") return "select";
  if (typeAttr === "file") return "file";
  if (typeAttr === "checkbox") return "checkbox";
  if (typeAttr === "radio") return "radio";
  if (typeAttr === "date" || typeAttr === "datetime-local") return "date";
  if (typeAttr === "email" || typeAttr === "tel" || typeAttr === "text" || typeAttr === "url" || typeAttr === "number") {
    return "text";
  }
  return "unknown";
}

function parseSelectOptions(inner: string): string[] {
  const opts: string[] = [];
  const re = /<option\b[^>]*>([\s\S]*?)<\/option>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    const t = stripTags(m[1] ?? "").trim();
    if (t) opts.push(t);
  }
  return opts;
}

function inferGreenhouseLabel(name: string, fallback: string): string | null {
  const map: Record<string, string> = {
    "job_application[first_name]": "First name",
    "job_application[last_name]": "Last name",
    "job_application[email]": "Email",
    "job_application[phone]": "Phone",
    "job_application[resume]": "Resume",
    "job_application[cover_letter]": "Cover letter",
  };
  return map[name] ?? (fallback.includes("[") ? null : fallback);
}

function looksLikeOptionOnlyLabel(text: string): boolean {
  return /^(yes|no|true|false|y|n|n\/a|none)$/i.test(text.trim());
}

function radioNeedsQuestionLabel(label: string, name: string | undefined): boolean {
  if (looksLikeOptionOnlyLabel(label)) return true;
  if (isUninformativeLabel(label)) return true;
  return name !== undefined && label === name;
}

/**
 * A question-only <label> with no `for` and no nested input — Paycom-class
 * lead-capture radios sit under `<label>Do you consent…?</label>` then
 * wrapping option labels. Preceding option-wrapping labels are skipped so
 * "Yes" is not stolen as the group question (see nearestSectionHeading).
 */
function nearestBareQuestionLabel(html: string, position: number): string | null {
  const window = html.slice(Math.max(0, position - 2_000), position);
  const re = /<label\b([^>]*)>([\s\S]*?)<\/label>/gi;
  let best: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(window)) !== null) {
    const attrs = m[1] ?? "";
    if (getAttr(attrs, "for")) continue;
    const body = m[2] ?? "";
    if (/<input\b/i.test(body)) continue;
    const text = cleanLabel(decodeEntities(stripTags(body)));
    if (text.length < 8 || text.length > 300) continue;
    if (looksLikeOptionOnlyLabel(text) || isUninformativeLabel(text)) continue;
    best = text;
  }
  return best;
}

function wrappingLabelTexts(
  html: string,
  inputStart: number,
  inputEnd: number,
): { full: string; after: string } | null {
  const before = html.slice(Math.max(0, inputStart - 800), inputStart);
  const lower = before.toLowerCase();
  const openIdx = lower.lastIndexOf("<label");
  const closeIdx = lower.lastIndexOf("</label");
  if (openIdx < 0 || openIdx < closeIdx) return null;
  const tagEnd = before.indexOf(">", openIdx);
  if (tagEnd < 0) return null;
  if (getAttr(before.slice(openIdx, tagEnd), "for")) return null;
  const afterChunk = html.slice(inputEnd, inputEnd + 500);
  const closeRel = afterChunk.search(/<\/label>/i);
  if (closeRel < 0) return null;
  const after = cleanLabel(decodeEntities(stripTags(afterChunk.slice(0, closeRel))));
  const innerStart = inputStart - before.length + tagEnd + 1;
  const full = cleanLabel(
    decodeEntities(stripTags(html.slice(innerStart, inputEnd + closeRel))),
  );
  if (!full && !after) return null;
  return { full, after };
}

function radioOptionText(input: {
  wrap: { full: string; after: string } | null;
  value: string | null;
  label: string;
  name: string | undefined;
}): string {
  const fromWrap = input.wrap?.after || input.wrap?.full || "";
  if (fromWrap && fromWrap !== input.name) return fromWrap;
  const value = input.value?.trim() ?? "";
  // Lever cards use value="0"/"1" with the visible answer in the wrapping
  // label. A bare integer is not an option the filler can click by label.
  if (value && !/^\d+$/.test(value)) return value;
  if (looksLikeOptionOnlyLabel(input.label)) return input.label;
  if (value) return value;
  return input.label;
}

function collapseRadioGroups(fields: DiscoveredField[]): DiscoveredField[] {
  const radios = new Map<string, DiscoveredField>();
  const out: DiscoveredField[] = [];
  for (const f of fields) {
    if (f.type === "radio" && f.name) {
      const optionSlice =
        f.options && f.options.length > 0 ? f.options : [f.label];
      const existing = radios.get(f.name);
      if (existing) {
        existing.options = [...(existing.options ?? []), ...optionSlice];
      } else {
        const group: DiscoveredField = {
          ...f,
          id: f.name,
          label: f.label,
          options: [...optionSlice],
        };
        radios.set(f.name, group);
        out.push(group);
      }
    } else {
      out.push(f);
    }
  }
  return out;
}
