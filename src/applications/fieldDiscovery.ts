import type { DiscoveredField } from "../ats/adapter.js";

/**
 * Offline HTML field discovery — no browser required.
 * Uses regex + lightweight heuristics suitable for fixture tests and Phase 4 dry-run.
 * Prefer label[for], aria-label, placeholder, name — not brittle class chains alone.
 */
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
