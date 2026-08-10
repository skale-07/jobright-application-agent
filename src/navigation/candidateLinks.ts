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
