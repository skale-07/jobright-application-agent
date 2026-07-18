import type { DiscoveredField } from "../ats/adapter.js";

/**
 * Map a discovered field label to a canonical candidate profile key
 * using answer-alias phrases (case-insensitive substring / exact match).
 */
export function normalizeFieldLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[*：:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchCanonicalField(
  field: DiscoveredField,
  aliases: Record<string, string[]>,
): string | null {
  const normalized = normalizeFieldLabel(field.label);
  const nameHint = (field.name ?? "").toLowerCase();

  for (const [canonical, phrases] of Object.entries(aliases)) {
    for (const phrase of phrases) {
      const p = normalizeFieldLabel(phrase);
      if (!p) continue;
      if (normalized === p || normalized.includes(p) || p.includes(normalized)) {
        return canonical;
      }
    }
    // Name-based Greenhouse hints
    if (canonical === "email" && /email/i.test(nameHint)) return canonical;
    if (canonical === "phone" && /phone/i.test(nameHint)) return canonical;
    if (canonical === "legal_name.first" && /first_name/i.test(nameHint)) {
      return canonical;
    }
    if (canonical === "legal_name.last" && /last_name/i.test(nameHint)) {
      return canonical;
    }
  }
  return null;
}

export type MappedField = DiscoveredField & {
  canonical_field: string | null;
  mapping_confidence: "high" | "medium" | "low" | "none";
};

export function mapDiscoveredFields(
  fields: DiscoveredField[],
  aliases: Record<string, string[]>,
): MappedField[] {
  return fields.map((f) => {
    const canonical = matchCanonicalField(f, aliases);
    let confidence: MappedField["mapping_confidence"] = "none";
    if (canonical) {
      const exact = aliases[canonical]?.some(
        (p) => normalizeFieldLabel(p) === normalizeFieldLabel(f.label),
      );
      confidence = exact ? "high" : "medium";
    }
    return {
      ...f,
      canonical_field: canonical,
      mapping_confidence: confidence,
    };
  });
}
