/**
 * Candidate-link selection for the nav agent's goal. The first hands-off
 * run proved the pattern: the one agent that WON navigated directly to a
 * URL; the six that LOST scrolled the jobright page hunting for an Apply
 * control that isn't there. Phase A already read the answer off the page —
 * greenhouse-board / Workday / career-site hrefs that merely failed the
 * STRICT application-URL validators — so hand those to the agent as
 * starting points instead of making it rediscover them by scrolling.
 *
 * Selection only — acceptance is unchanged (congruence + final-URL
 * validation gate what is ever stored).
 */

import { validateGreenhouseApplicationUrl } from "../ats/greenhouse/urlValidation.js";
import { validateLeverApplicationUrl } from "../ats/lever/urlValidation.js";
import { validateAshbyApplicationUrl } from "../ats/ashby/urlValidation.js";
import { validateWorkableApplicationUrl } from "../ats/workable/urlValidation.js";

/** Hosts that are never an application route — social/press links. */
const SOCIAL_HOST_RE =
  /(^|\.)(x\.com|twitter\.com|linkedin\.com|facebook\.com|instagram\.com|youtube\.com|crunchbase\.com|glassdoor\.com|wellfound\.com|medium\.com|github\.com|tiktok\.com)$/i;

/** ATS-ish hosts get first priority even when the exact URL shape failed validation. */
const ATS_HINT_RE =
  /greenhouse|lever\.co|ashbyhq|workable|myworkdayjobs|icims|smartrecruiters|jobvite|bamboohr|rippling|recruitee|taleo|successfactors/i;

export function selectCandidateApplyLinks(
  hrefs: string[],
  limit = 4,
): string[] {
  const scored: Array<{ url: string; score: number }> = [];
  const seenHosts = new Set<string>();
  for (const href of hrefs) {
    let host: string;
    try {
      host = new URL(href).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (SOCIAL_HOST_RE.test(host)) continue;
    // One candidate per host — the page often repeats the same board link.
    if (seenHosts.has(host)) continue;
    seenHosts.add(host);
    let score = 1;
    if (ATS_HINT_RE.test(host)) score += 4;
    if (/careers?|jobs?|apply|talent/i.test(host)) score += 2;
    if (/apply|careers?|jobs?|positions?|openings?/i.test(href)) score += 1;
    scored.push({ url: href, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.url);
}

const ATS_FAMILIES: Array<{
  hostRe: RegExp;
  name: string;
  validate: (url: string) => { passed: boolean; failureReason: string | null };
}> = [
  { hostRe: /(^|\.)greenhouse\.io$/i, name: "greenhouse", validate: validateGreenhouseApplicationUrl },
  { hostRe: /(^|\.)lever\.co$/i, name: "lever", validate: validateLeverApplicationUrl },
  { hostRe: /(^|\.)ashbyhq\.com$/i, name: "ashby", validate: validateAshbyApplicationUrl },
  { hostRe: /(^|\.)workable\.com$/i, name: "workable", validate: validateWorkableApplicationUrl },
];

/**
 * Name WHY an anchor on a supported-ATS host failed strict validation.
 * Session 4a7c199b: a Figma job died as a budget wall while the page held a
 * boards.greenhouse.io anchor — the report showed only the hostname, so
 * whether the anchor was a board root, an odd path shape, or a validator
 * gap was undiagnosable from artifacts. Host + path only (query strings can
 * carry tokens); acceptance rules are unchanged — this is diagnostics.
 */
export function explainAtsAnchorMisses(hrefs: string[], limit = 3): string[] {
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const href of hrefs) {
    if (notes.length >= limit) break;
    let parsed: URL;
    try {
      parsed = new URL(href);
    } catch {
      continue;
    }
    const host = parsed.hostname.toLowerCase();
    const family = ATS_FAMILIES.find((f) => f.hostRe.test(host));
    if (!family) continue;
    const verdict = family.validate(href);
    if (verdict.passed) continue;
    const key = `${host}${parsed.pathname}`;
    if (seen.has(key)) continue;
    seen.add(key);
    notes.push(
      `phase A: ${family.name}-host anchor failed strict validation: ${key} — ${(verdict.failureReason ?? "unknown").slice(0, 140)}`,
    );
  }
  return notes;
}

/**
 * Employer-sibling suffixes the agent may traverse. Live (2026-08-12): the
 * agent followed joinbytedance.com -> jobs.bytedance.com — the real apply
 * path — and the whole turn was demoted for "allowed_domains violated"
 * because only the literal job-page host was allowed. Career sites
 * routinely redirect across sibling domains of the same brand, so allow
 * the registrable domain of every job-page host plus a company-name
 * domain. Traversal is NOT acceptance: congruence and final-URL validation
 * still decide what may be stored.
 */
export function employerSiblingHosts(
  hrefs: string[],
  company: string | null,
): string[] {
  const out = new Set<string>();
  const registrable = (host: string): string | null => {
    const parts = host.split(".");
    return parts.length >= 2 ? parts.slice(-2).join(".") : null;
  };
  for (const href of hrefs) {
    try {
      const host = new URL(href).hostname.toLowerCase();
      if (SOCIAL_HOST_RE.test(host)) continue;
      const base = registrable(host);
      if (base) out.add(base);
    } catch {
      // malformed — skip
    }
  }
  const token = (company ?? "")
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|corporation|company|co|the|an?|ibm)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
  if (token.length >= 4) out.add(`${token}.com`);
  return [...out];
}

/** Non-social hostnames for the agent's traversal allowlist. */
export function traversalHosts(hrefs: string[]): string[] {
  const hosts = new Set<string>();
  for (const href of hrefs) {
    try {
      const host = new URL(href).hostname.toLowerCase();
      if (!SOCIAL_HOST_RE.test(host)) hosts.add(host);
    } catch {
      // malformed — skip
    }
  }
  return [...hosts];
}
