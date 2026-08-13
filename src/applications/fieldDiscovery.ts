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
  html: string,
  opts?: { preferGreenhouse?: boolean },
): DiscoveredField[] {
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
    const required =
      /\brequired\b/i.test(attrs) ||
      /aria-required=["']true["']/i.test(attrs);

    let label =
      (inputId ? labelMap.get(inputId) : undefined) ??
      ariaLabel ??
      placeholder ??
      name ??
      `field_${idx}`;

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

    const fieldType = mapType(tag, typeAttr);
    const options =
      tag === "select" ? parseSelectOptions(inner) : undefined;

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

function collapseRadioGroups(fields: DiscoveredField[]): DiscoveredField[] {
  const radios = new Map<string, DiscoveredField>();
  const out: DiscoveredField[] = [];
  for (const f of fields) {
    if (f.type === "radio" && f.name) {
      const existing = radios.get(f.name);
      if (existing) {
        existing.options = [...(existing.options ?? []), f.label];
      } else {
        const group: DiscoveredField = {
          ...f,
          id: f.name,
          label: f.label,
          options: [f.label],
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
