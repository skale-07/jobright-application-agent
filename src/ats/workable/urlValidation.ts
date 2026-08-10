/**
 * Strict Workable application URL validation. Mirrors the Lever validator's
 * rejection battery (scheme, credentials, port, host allowlist, marketing
 * paths) with Workable's URL shapes:
 *   - apply.workable.com/<company>/j/<SHORTCODE>(/apply)?   (canonical)
 *   - <company>.workable.com/j/<SHORTCODE>                  (legacy — normalized)
 * Normalizes to https://apply.workable.com/<company>/j/<SHORTCODE>/apply/.
 */

const CANONICAL_HOST = "apply.workable.com";

/** Subdomains that are never a company job board. */
const NON_COMPANY_SUBDOMAINS = new Set([
  "www",
  "apply",
  "jobs",
  "help",
  "resources",
  "careers",
  "developers",
  "status",
]);

const CANONICAL_PATH =
  /^\/([a-z0-9][a-z0-9_.-]*)\/j\/([A-Za-z0-9]{6,20})(\/apply)?\/?$/i;
const LEGACY_PATH = /^\/j\/([A-Za-z0-9]{6,20})\/?$/i;

export type WorkableUrlValidation = {
  passed: boolean;
  normalizedUrl: string | null;
  host: string | null;
  company: string | null;
  shortcode: string | null;
  warnings: string[];
  failureReason: string | null;
};

function fail(reason: string, warnings: string[] = []): WorkableUrlValidation {
  return {
    passed: false,
    normalizedUrl: null,
    host: null,
    company: null,
    shortcode: null,
    warnings,
    failureReason: reason,
  };
}

function pass(
  company: string,
  shortcode: string,
  warnings: string[],
): WorkableUrlValidation {
  return {
    passed: true,
    normalizedUrl: `https://${CANONICAL_HOST}/${company}/j/${shortcode.toUpperCase()}/apply/`,
    host: CANONICAL_HOST,
    company,
    shortcode: shortcode.toUpperCase(),
    warnings,
    failureReason: null,
  };
}

export function validateWorkableApplicationUrl(
  rawUrl: string,
): WorkableUrlValidation {
  const warnings: string[] = [];
  const trimmed = rawUrl.trim();
  if (!trimmed) return fail("Empty URL");

  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith("javascript:") ||
    lower.startsWith("data:") ||
    lower.startsWith("file:") ||
    lower.startsWith("vbscript:")
  ) {
    return fail(`Forbidden URL scheme: ${trimmed.slice(0, 32)}`);
  }

  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return fail(`Malformed URL: ${trimmed}`);
  }

  if (u.protocol !== "https:") {
    return fail(`Non-HTTPS URL rejected: ${u.protocol}`);
  }
  if (u.username || u.password) {
    return fail("URLs with credentials are rejected");
  }
  if (u.port && u.port !== "" && u.port !== "443") {
    return fail(`Unexpected port rejected: ${u.port}`);
  }

  const host = u.hostname.toLowerCase();

  if (host === CANONICAL_HOST) {
    const m = u.pathname.match(CANONICAL_PATH);
    if (!m) {
      return fail(
        `URL is not a recognizable Workable posting/application path: ${u.pathname}`,
      );
    }
    const company = m[1]!.toLowerCase();
    if (!m[3]) {
      warnings.push("Posting URL without /apply — normalized to the form URL");
    }
    return pass(company, m[2]!, warnings);
  }

  // Legacy company subdomain: <company>.workable.com/j/<SHORTCODE>.
  const sub = host.match(/^([a-z0-9][a-z0-9-]*)\.workable\.com$/);
  if (sub) {
    const company = sub[1]!;
    if (NON_COMPANY_SUBDOMAINS.has(company)) {
      return fail(`Workable host not allowlisted for application URLs: ${host}`);
    }
    const m = u.pathname.match(LEGACY_PATH);
    if (!m) {
      return fail(
        `URL is not a recognizable Workable posting path on a company subdomain: ${u.pathname}`,
      );
    }
    warnings.push(
      `Legacy company-subdomain URL normalized to ${CANONICAL_HOST}`,
    );
    return pass(company, m[1]!, warnings);
  }

  return fail(`Non-Workable host rejected: ${host}`);
}

export function isTrustedWorkableHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === CANONICAL_HOST) return true;
    const sub = host.match(/^([a-z0-9][a-z0-9-]*)\.workable\.com$/);
    return sub !== null && !NON_COMPANY_SUBDOMAINS.has(sub[1]!);
  } catch {
    return false;
  }
}
