import type { DiscoveredField } from "../ats/adapter.js";

/**
 * Map a discovered field label to a canonical candidate profile key
 * using answer-alias phrases (case-insensitive substring / exact match).
 *
 * Longest phrase wins so bare "Gender" does not steal "gender identity" fields
 * and vice versa.
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

  let best: { canonical: string; score: number } | null = null;

  for (const [canonical, phrases] of Object.entries(aliases)) {
    for (const phrase of phrases) {
      const p = normalizeFieldLabel(phrase);
      if (!p) continue;
      let score = 0;
      if (normalized === p) {
        // Exact label win — pad so short exact "Gender" beats a looser long include.
        score = 10_000 + p.length;
      } else if (normalized.includes(p)) {
        score = 100 + p.length;
      } else if (p.includes(normalized) && normalized.length >= 4) {
        score = 50 + normalized.length;
      } else {
        continue;
      }
      if (!best || score > best.score) {
        best = { canonical, score };
      }
    }
  }

  if (best) return best.canonical;

  // Name-based Greenhouse hints (only when phrase map missed)
  if (/email/i.test(nameHint)) return "email";
  if (/phone/i.test(nameHint)) return "phone";
  if (/first_name/i.test(nameHint)) return "legal_name.first";
  if (/last_name/i.test(nameHint)) return "legal_name.last";
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
