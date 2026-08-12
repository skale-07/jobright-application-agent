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
 * The check is pure string work on data we already hold: no network, no
 * LLM. Evidence is read in order of authority — the org slug a supported
 * ATS embeds in the URL (jobs.ashbyhq.com/<org>/…, jobs.lever.co/<org>/…,
 * boards.greenhouse.io/<org>/…), then the employer's own hostname
 * (careers.ibm.com), then the path segments a multi-employer board uses to
 * name its employers (ycombinator.com/companies/<org>/…). "unknown" is
 * reserved for URLs that genuinely carry no employer name at all; those
 * route to human review, which is the correct authority.
 *
 * Reading past the ATS shapes was added 2026-08-12: four navigations
 * resolved correct employer URLs (jobvite, citadel.com, careers.ibm.com,
 * ycombinator) and all four came back "no org slug decodable" while the
 * company name sat in the hostname or the first path segment.
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
  if (host === "apply.workable.com") return first;
  {
    // Legacy Workable company subdomains: <company>.workable.com/j/<code>
    const sub = host.match(/^([a-z0-9][a-z0-9-]*)\.workable\.com$/);
    if (sub && sub[1] !== "apply" && sub[1] !== "www" && sub[1] !== "jobs") {
      return sub[1] ?? null;
    }
  }
  {
    // Workday: <tenant>.wdN.myworkdayjobs.com — the tenant subdomain is the
    // employer slug (e.g. interdigital, medtronic).
    const wd = host.match(/^([a-z0-9][a-z0-9-]*)\.wd\d+\.myworkdayjobs\.com$/);
    if (wd) return wd[1] ?? null;
  }
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

/**
 * URL words that name a page, not an employer. These are dropped before
 * anything is treated as identity evidence — "careers" matching a company
 * called "Careers Inc" is the kind of coincidence that makes a verdict
 * worthless.
 */
const GENERIC_URL_WORDS = new Set([
  "www", "www2", "careers", "career", "jobs", "job", "apply", "application",
  "applications", "recruiting", "recruitment", "hiring", "hire", "join",
  "work", "talent", "people", "boards", "board", "portal", "external",
  "secure", "my", "en", "us", "uk", "en-us", "en_us", "global", "search",
  "openings", "opening", "listing", "listings", "position", "positions",
  "role", "roles", "detail", "details", "companies", "company", "posting",
  "postings", "vacancy", "vacancies", "index", "home", "main", "site",
  // locale segments, already compacted (en_US -> "enus")
  "enus", "engb", "enca", "enau", "frfr", "frca", "dede", "eses", "ptbr",
  "jajp", "zhcn", "kokr", "itit", "nlnl",
]);

/**
 * Hosts that carry MANY employers' postings. On these the hostname names
 * the board, never the employer — so the employer must come from the path
 * (ycombinator.com/companies/<org>/jobs/…, jobs.jobvite.com/<org>/…), and
 * the hostname itself must never be read as identity evidence.
 */
const MULTI_EMPLOYER_HOSTS = [
  "jobvite.com", "ycombinator.com", "smartrecruiters.com", "icims.com",
  "taleo.net", "brassring.com", "successfactors.com", "myworkdaysite.com",
  "oraclecloud.com", "wellfound.com", "builtin.com", "linkedin.com",
  "indeed.com", "glassdoor.com", "dice.com", "ziprecruiter.com",
  "jobs.net", "recruitee.com", "teamtailor.com", "personio.de",
  "bamboohr.com", "paylocity.com", "adp.com", "jazzhr.com", "breezy.hr",
  "pinpointhq.com", "rippling.com", "gem.com", "eightfold.ai",
  // Live 2026-08-12: jobs.gusto.com/postings/gesture-us-inc-…/applicants/new
  // is a GESTURE posting on Gusto's board. Without gusto.com here the
  // hostname would be read as the employer and accuse a correct URL.
  "gusto.com",
];

/**
 * Country second-level domains, so `careers.acme.co.uk` drops two labels
 * while `careers.ibm.com` drops one. Getting this wrong ate "ibm" during
 * development — a generic "second-to-last label is short" rule discards
 * three-letter COMPANY names, which is exactly the case that matters.
 */
const COUNTRY_SLDS = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au",
  "co.jp", "or.jp", "com.br", "com.mx", "co.in", "com.sg", "com.hk",
  "co.nz", "co.za", "com.cn", "com.tr", "co.kr", "com.ar",
]);

/** Hostname labels that could name an employer (TLD and suffix removed). */
function hostNameLabels(host: string): string[] {
  const labels = host.split(".");
  if (labels.length <= 1) return labels;
  const lastTwo = labels.slice(-2).join(".");
  const drop = COUNTRY_SLDS.has(lastTwo) ? 3 : 2;
  // Keep everything up to and including the registrable label.
  return labels.slice(0, Math.max(1, labels.length - drop + 1));
}

export type OrgCandidate = {
  value: string;
  source: "ats_slug" | "host" | "path";
};

/**
 * Every decodable employer name in a URL, best evidence first.
 *
 * Live gap (2026-08-12): four navigations resolved perfectly good employer
 * URLs — jobs.jobvite.com/altamiracorps/…, www.citadel.com/careers/…,
 * careers.ibm.com/…, ycombinator.com/companies/effigov/… — and every one
 * came back "no org slug decodable from URL (unsupported host)", because
 * only the five supported ATS URL shapes were understood. The company name
 * was sitting in the hostname or the first path segment the whole time.
 */
export function extractOrgCandidates(url: string): OrgCandidate[] {
  const out: OrgCandidate[] = [];
  const push = (value: string | null | undefined, source: OrgCandidate["source"]): void => {
    const clean = (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (clean.length < 2) return;
    if (/^\d+$/.test(clean)) return; // job/req ids are never employer names
    if (GENERIC_URL_WORDS.has(clean)) return;
    if (out.some((c) => c.value === clean)) return;
    out.push({ value: clean, source });
  };

  const slug = extractOrgSlug(url);
  if (slug) push(slug, "ats_slug");

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return out;
  }
  const host = parsed.hostname.toLowerCase();
  const onMultiEmployerHost = MULTI_EMPLOYER_HOSTS.some(
    (h) => host === h || host.endsWith(`.${h}`),
  );

  // The employer's own domain is strong evidence — careers.ibm.com is IBM.
  // A multi-employer board's hostname is not: it names the board.
  if (!onMultiEmployerHost) {
    for (const label of hostNameLabels(host)) push(label, "host");
  }

  // Path segments: the only place a board names the employer, and a useful
  // second opinion on a corporate host.
  for (const segment of parsed.pathname.split("/").filter(Boolean).slice(0, 3)) {
    push(segment, "path");
  }
  return out;
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
  const candidates = extractOrgCandidates(url);
  const atsSlug = candidates.find((c) => c.source === "ats_slug")?.value ?? null;
  if (candidates.length === 0) {
    return {
      verdict: "unknown",
      slug: null,
      detail: "no employer name decodable from URL (host and path are generic)",
    };
  }
  const id = companyIdentity(company);
  if (id.tokens.length === 0 && id.aliases.length === 0) {
    return {
      verdict: "unknown",
      slug: atsSlug ?? candidates[0]!.value,
      detail: "company name yields no comparable tokens",
    };
  }

  for (const candidate of candidates) {
    const hit = slugMatchesCompany(candidate.value, id);
    if (hit) {
      return {
        verdict: "match",
        slug: candidate.value,
        detail:
          candidate.source === "ats_slug"
            ? hit
            : `${hit} (from URL ${candidate.source})`,
      };
    }
  }

  // Nothing matched. An ATS slug is authoritative — the vendor puts the
  // employer there and nowhere else — so a miss is a real mismatch. Off a
  // known ATS, only a SPECIFIC candidate (>=4 chars) is confident enough
  // to park on: short hostname labels are too noisy to accuse with.
  const specific = candidates.find((c) => c.value.length >= 4);
  if (atsSlug) {
    return {
      verdict: "mismatch",
      slug: atsSlug,
      detail: `slug "${atsSlug}" shares nothing with company "${company}"`,
    };
  }
  if (specific) {
    return {
      verdict: "mismatch",
      slug: specific.value,
      detail: `URL names "${specific.value}" (${specific.source}), which shares nothing with company "${company}"`,
    };
  }
  return {
    verdict: "unknown",
    slug: candidates[0]!.value,
    detail: `URL carries no employer name specific enough to verify against "${company}"`,
  };
}

/** Shared token/initials/joined comparison; returns the reason on a hit. */
function slugMatchesCompany(
  slugCompact: string,
  id: CompanyIdentity,
): string | null {
  for (const token of [...id.tokens, ...id.aliases]) {
    if (token.length >= 3 && (slugCompact.includes(token) || token.includes(slugCompact))) {
      return `token "${token}" ~ slug "${slugCompact}"`;
    }
    // Short brand names ("co", "x") only match the slug exactly.
    if (token.length === 2 && token === slugCompact) {
      return `token "${token}" = slug`;
    }
  }
  if (id.initials.length >= 2 && slugCompact === id.initials) {
    return `initials "${id.initials}" = slug "${slugCompact}"`;
  }
  if (
    id.joined.length >= 4 &&
    slugCompact.length >= 4 &&
    (slugCompact.includes(id.joined) || id.joined.includes(slugCompact))
  ) {
    return `joined name ~ slug "${slugCompact}"`;
  }
  return null;
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
