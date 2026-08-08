/**
 * Deterministic outreach-contact ranking — no model, fully auditable.
 * The tail used to take the FIRST contact with a name+email; the referral
 * is the product's second half, so who receives it matters. Score by how
 * likely the person is to act on a cold student intro: recruiting roles
 * answer, then people whose title overlaps the role being applied to,
 * then seniority that suggests hiring input.
 */
import type { ContactRow } from "./repository.js";

const RECRUITING = /recruit|talent|people|university|campus|early careers?|hr\b/i;
const HIRING_SENIORITY = /manager|lead|head|director|principal|staff/i;
const STOPWORDS = new Set([
  "intern",
  "internship",
  "and",
  "the",
  "of",
  "sr",
  "jr",
  "senior",
  "junior",
  "i",
  "ii",
  "iii",
]);

function roleTokens(role: string | null | undefined): Set<string> {
  if (!role) return new Set();
  return new Set(
    role
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

export function scoreContact(
  contact: Pick<ContactRow, "name" | "email" | "title" | "source_category">,
  jobRole: string | null | undefined,
): number {
  // Unreachable contacts are unusable whatever their title.
  if (!contact.name || !contact.email) return -1;
  let score = 1;
  const title = contact.title ?? "";
  if (RECRUITING.test(title) || RECRUITING.test(contact.source_category ?? "")) {
    score += 8;
  }
  const overlap = [...roleTokens(jobRole)].filter((t) =>
    title.toLowerCase().includes(t),
  ).length;
  score += Math.min(overlap, 3) * 2;
  if (HIRING_SENIORITY.test(title)) score += 1;
  return score;
}

/** Highest-scoring first; ties keep repository order (stable). */
export function rankOutreachContacts<
  T extends Pick<ContactRow, "name" | "email" | "title" | "source_category">,
>(contacts: T[], jobRole: string | null | undefined): T[] {
  return contacts
    .map((c, i) => ({ c, i, s: scoreContact(c, jobRole) }))
    .filter((e) => e.s >= 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((e) => e.c);
}
