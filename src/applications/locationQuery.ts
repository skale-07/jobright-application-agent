/**
 * Expand bare city for location typeaheads
 * ("Baltimore" + MD + US → "Baltimore, Maryland, USA").
 */
export function locationTypeaheadQuery(
  city: string,
  state?: string | null,
  country?: string | null,
): string {
  const c = city.trim();
  if (!c) return c;
  const parts = [c];
  const st = (state ?? "").trim();
  if (st && !c.toLowerCase().includes(st.toLowerCase())) parts.push(st);
  const co = (country ?? "").trim();
  if (co) {
    const usa = /united states|usa|u\.s\.a\.?/i.test(co);
    const token = usa ? "USA" : co;
    if (!parts.join(" ").toLowerCase().includes(token.toLowerCase())) {
      parts.push(token);
    }
  }
  return parts.join(", ");
}

/**
 * True when observed location is an expanded Places commit of the expected
 * city. This feeds the pre-click VERIFY gate, so every fallback is gated:
 * a false positive here lets a wrong committed suggestion through to submit,
 * while a false negative merely parks the app for review. Only apply this
 * to location fields (address.city) — a bare first-token containment check
 * is far too loose for arbitrary values.
 */
export function locationsMatch(expected: string, observed: string): boolean {
  const e = expected.trim().toLowerCase();
  const o = observed.trim().toLowerCase();
  if (!e || !o) return false;
  if (e === o) return true;
  // Substring containment only for strings long enough to be a place name —
  // "No" must not match inside "I do NOt want to answer".
  if ((e.length >= 4 && o.includes(e)) || (o.length >= 4 && e.includes(o))) {
    return true;
  }
  // City-segment match ("Baltimore, Maryland, USA" vs "Baltimore, MD, United
  // States"; "New York, NY" vs "New York, New York, USA"): everything before
  // the first comma, whole-word, ≥4 chars — so "i"/"no"/"new" can never match.
  const eCity = (e.split(",")[0] ?? e).trim();
  if (
    eCity.length >= 4 &&
    new RegExp(`\\b${eCity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(o)
  ) {
    return true;
  }
  return false;
}
