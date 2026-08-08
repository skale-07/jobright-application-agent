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

/** True when observed location is an expanded Places commit of the expected city. */
export function locationsMatch(expected: string, observed: string): boolean {
  const e = expected.trim().toLowerCase();
  const o = observed.trim().toLowerCase();
  if (!e || !o) return false;
  if (e === o) return true;
  if (o.includes(e) || e.includes(o)) return true;
  const eCity = e.split(/[,\s]+/).filter(Boolean)[0] ?? e;
  if (eCity.length >= 3 && o.includes(eCity)) return true;
  // "MD" vs "Maryland"
  const compact = (s: string) => s.replace(/[^a-z0-9]+/g, "");
  if (compact(o).includes(compact(eCity))) return true;
  return false;
}
