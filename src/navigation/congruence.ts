import type { Db } from "../storage/db/client.js";
import { detectAtsFromUrl } from "../ats/shared/urlValidationDispatch.js";

/**
 * Resolution congruence — the deterministic identity check between a
 * navigation-resolved URL and the job record it is being resolved FOR.
 * Born from a live L3 session where the agent phase returned the same
 * Cohere application URL for three unrelated jobs (a leftover tab in the
 * operator's CDP Chrome): host-only acceptance let a wrong-company URL be
 * persisted, filled, and carried to the submit gate. Per the validation
 * ladder, an agent's self-report carries no level until independently
 * verified — this module is that verification for navigation results.
 *
 * The check is pure string work on data we already hold: every supported
 * ATS embeds the employer's org slug in the URL (jobs.ashbyhq.com/<org>/…,
 * jobs.lever.co/<org>/…, boards.greenhouse.io/<org>/…), so no network and
 * no LLM is involved. Unknown hosts return "unknown" — those URLs already
 * route to UNSUPPORTED_ATS human review, which is the correct authority.
 *
 * Fail-closed on identity: a false mismatch costs the operator one review
 * click; a false match nearly submits to the wrong company.
 */

const LEGAL_SUFFIXES = new Set([
  "inc",
  "incorporated",
  "llc",
  "llp",
  "ltd",
  "limited",
  "corp",
  "corporation",
  "co",
  "company",
  "gmbh",
  "plc",
  "pbc",
  "sa",
  "sas",
  "bv",
  "ag",
  "pty",
]);

const STOPWORDS = new Set(["the", "of", "and", "for", "a", "an", "at", "in"]);

export type CompanyIdentity = {
  /** Meaningful lowercase tokens, legal suffixes and stopwords removed. */
  tokens: string[];
  /** Initials of ALL name tokens (pre-stopword), e.g. "esg" for "Energy Systems Group". */
  initials: string;
  /** Tokens joined with no separator, e.g. "amalegalsolutions". */
  joined: string;
  /** Extra token sets from parentheticals, e.g. "(ESG)" → ["esg"]. */
  aliases: string[];
};

export function companyIdentity(rawCompany: string): CompanyIdentity {
  const aliases: string[] = [];
  let name = rawCompany;
  // Parentheticals are usually the short/brand name — keep them as aliases.
  name = name.replace(/\(([^)]{1,40})\)/g, (_m, inner: string) => {
    const cleaned = inner.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (cleaned.length >= 2) aliases.push(cleaned);
    return " ";
  });
  const rawTokens = name
    .toLowerCase()
    .replace(/[®™©]/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
  const initials = rawTokens.map((t) => t[0]).join("");
  const tokens = rawTokens.filter(
    (t) => !LEGAL_SUFFIXES.has(t) && !STOPWORDS.has(t) && t.length >= 2,
  );
  return {
    tokens,
    initials,
    joined: tokens.join(""),
    aliases,
  };
}

/** Org slug from a supported-ATS URL, or null when the host is unknown. */
export function extractOrgSlug(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split("/").filter((s) => s.length > 0);
  const first = segments[0]?.toLowerCase() ?? null;
  if (host === "jobs.ashbyhq.com") return first;
  if (host === "jobs.lever.co" || host === "jobs.eu.lever.co") return first;
  if (
    host === "boards.greenhouse.io" ||
    host === "job-boards.greenhouse.io" ||
    host === "boards.eu.greenhouse.io" ||
    host === "job-boards.eu.greenhouse.io"
  ) {
    // greenhouse embed URLs use /embed/job_app?for=<org>
    if (first === "embed") return parsed.searchParams.get("for")?.toLowerCase() ?? null;
    return first;
  }
  return null;
}

export type CongruenceVerdict = {
  verdict: "match" | "mismatch" | "unknown";
  slug: string | null;
  detail: string;
};

/**
 * Does this URL plausibly belong to this company? "unknown" means the URL
 * carries no decodable org identity (unsupported host) — the caller must
 * treat that as "human decides", never as a pass.
 */
export function checkUrlCongruence(
  company: string,
  url: string,
): CongruenceVerdict {
  const slug = extractOrgSlug(url);
  if (!slug || slug.length < 2) {
    return {
      verdict: "unknown",
      slug: null,
      detail: "no org slug decodable from URL (unsupported host)",
    };
  }
  const id = companyIdentity(company);
  if (id.tokens.length === 0 && id.aliases.length === 0) {
    return {
      verdict: "unknown",
      slug,
      detail: "company name yields no comparable tokens",
    };
  }

  const slugCompact = slug.replace(/[^a-z0-9]/g, "");
  const candidates = [...id.tokens, ...id.aliases];
  for (const token of candidates) {
    if (token.length >= 3 && (slugCompact.includes(token) || token.includes(slugCompact))) {
      return {
        verdict: "match",
        slug,
        detail: `token "${token}" ~ slug "${slug}"`,
      };
    }
    // Short brand names ("co", "x") only match the slug exactly.
    if (token.length === 2 && token === slugCompact) {
      return { verdict: "match", slug, detail: `token "${token}" = slug` };
    }
  }
  if (id.initials.length >= 2 && slugCompact === id.initials) {
    return {
      verdict: "match",
      slug,
      detail: `initials "${id.initials}" = slug "${slug}"`,
    };
  }
  if (id.joined.length >= 4 && (slugCompact.includes(id.joined) || id.joined.includes(slugCompact)) && slugCompact.length >= 4) {
    return {
      verdict: "match",
      slug,
      detail: `joined name ~ slug "${slug}"`,
    };
  }
  return {
    verdict: "mismatch",
    slug,
    detail: `slug "${slug}" shares nothing with company "${company}"`,
  };
}

/** Company + role for an application, straight off the job row. */
export function getJobIdentity(
  db: Db,
  applicationId: string,
): { company: string; role: string } | null {
  const row = db
    .prepare(
      `SELECT j.company, j.role FROM jobs j
       JOIN applications a ON a.job_id = j.id WHERE a.id = ?`,
    )
    .get(applicationId) as { company: string; role: string } | undefined;
  return row ?? null;
}

/**
 * Other live applications already holding this employer URL. A posting
 * should never have two applications marching toward submit — a hit here
 * means either the agent returned a stale/wrong tab, or JobRight listed
 * the same posting under multiple job cards. Either way: park, don't fill.
 */
export function findApplicationsWithEmployerUrl(
  db: Db,
  url: string,
  excludeApplicationId: string,
): Array<{ application_id: string; state: string; company: string; role: string }> {
  const detected = detectAtsFromUrl(url);
  const normalized = detected.ats !== null ? detected.normalizedUrl : url;
  const stripped = normalized.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const rows = db
    .prepare(
      `SELECT a.id AS application_id, a.state, j.company, j.role,
              json_extract(j.raw_json, '$.employer_application_url') AS employer_url
       FROM applications a JOIN jobs j ON a.job_id = j.id
       WHERE a.id != ? AND json_extract(j.raw_json, '$.employer_application_url') IS NOT NULL`,
    )
    .all(excludeApplicationId) as Array<{
    application_id: string;
    state: string;
    company: string;
    role: string;
    employer_url: string;
  }>;
  return rows
    .filter((r) => {
      const other = r.employer_url.replace(/[?#].*$/, "").replace(/\/+$/, "");
      return other === stripped;
    })
    .map(({ application_id, state, company, role }) => ({
      application_id,
      state,
      company,
      role,
    }));
}
