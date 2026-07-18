import { z } from "zod";
import { jobrightSelectorsV1 } from "./selectors/v1.js";

export const parsedJobCardSchema = z.object({
  jobright_job_id: z.string().min(1),
  role: z.string().min(1),
  company: z.string().min(1),
  location: z.string().nullable(),
  employment_type: z.string().nullable(),
  job_path: z.string(),
  job_url: z.string().url(),
  apply_cta_visible: z.boolean(),
});

export type ParsedJobCard = z.infer<typeof parsedJobCardSchema>;

/**
 * Offline parser for sanitized JobRight feed HTML (from recorder captures).
 * Associates fields by document order of first appearance (JobRight card layout).
 */
export function parseJobCardsFromFeedHtml(html: string): ParsedJobCard[] {
  const applyVisible = /apply with autofill/i.test(html);

  const ids = uniqueInOrder(
    [...html.matchAll(new RegExp(jobrightSelectorsV1.urls.jobInfoUrlPattern, "gi"))].map(
      (m) => m[1] ?? "",
    ),
  );

  const titles = [
    ...html.matchAll(/index_job-title__[A-Za-z0-9]+[^>]*>([^<]+)</gi),
  ].map((m) => decodeHtml(m[1] ?? "").trim());

  const companies = [
    ...html.matchAll(/index_company-name__[A-Za-z0-9]+[^>]*>([^<]+)</gi),
  ].map((m) => decodeHtml(m[1] ?? "").trim());

  const locations = [
    ...html.matchAll(/index_primary-location__[A-Za-z0-9]+[^>]*>([^<]+)</gi),
  ].map((m) => decodeHtml(m[1] ?? "").trim());

  const cards: ParsedJobCard[] = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (!id) continue;
    const role = titles[i] ?? `Job ${id.slice(0, 8)}`;
    const company = companies[i] ?? "Unknown company";
    const location = locations[i] ?? null;
    const path = `${jobrightSelectorsV1.urls.jobInfoPathPrefix}${id}`;
    const parsed = parsedJobCardSchema.safeParse({
      jobright_job_id: id,
      role,
      company,
      location,
      employment_type: inferEmploymentType(role),
      job_path: path,
      job_url: `https://jobright.ai${path}`,
      apply_cta_visible: applyVisible,
    });
    if (parsed.success) cards.push(parsed.data);
  }
  return cards;
}

function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

export function inferEmploymentType(text: string): string | null {
  if (/internship|\bintern\b/i.test(text)) return "Internship";
  if (/new\s*grad/i.test(text)) return "New Grad";
  if (/full[-\s]?time/i.test(text)) return "Full-time";
  return null;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\u00a0/g, " ");
}
