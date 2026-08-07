/**
 * Strict Lever application URL validation. Mirrors the Greenhouse validator's
 * rejection battery (scheme, credentials, port, host allowlist, marketing
 * paths) with Lever's URL shape: /<company>/<posting-uuid>(/apply)?.
 * Normalizes to the /apply form URL.
 */

const ALLOWED_HOSTS = new Set(["jobs.lever.co", "jobs.eu.lever.co"]);

const POSTING_PATH =
  /^\/([a-z0-9][a-z0-9_.-]*)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/apply)?\/?$/i;

export type LeverUrlValidation = {
  passed: boolean;
  normalizedUrl: string | null;
  host: string | null;
  company: string | null;
  postingId: string | null;
  warnings: string[];
  failureReason: string | null;
};

function fail(reason: string, warnings: string[] = []): LeverUrlValidation {
  return {
    passed: false,
    normalizedUrl: null,
    host: null,
    company: null,
    postingId: null,
    warnings,
    failureReason: reason,
  };
}

export function validateLeverApplicationUrl(rawUrl: string): LeverUrlValidation {
  const warnings: string[] = [];
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return fail("Empty URL");
  }

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
  if (!ALLOWED_HOSTS.has(host)) {
    if (/(^|\.)lever\.co$/i.test(host)) {
      return fail(`Lever host not allowlisted for application URLs: ${host}`);
    }
    return fail(`Non-Lever host rejected: ${host}`);
  }

  const path = u.pathname.replace(/\/+$/, "") || "/";
  if (path === "/" || path === "") {
    return fail("Lever job-board root URL rejected — no posting id");
  }

  const pathMatch = u.pathname.match(POSTING_PATH);
  if (!pathMatch) {
    return fail(
      `URL is not a recognizable Lever posting/application path: ${u.pathname}`,
    );
  }

  const company = pathMatch[1]!.toLowerCase();
  const postingId = pathMatch[2]!.toLowerCase();
  if (!pathMatch[3]) {
    warnings.push("Posting URL without /apply — normalized to the form URL");
  }

  const normalized = new URL(`https://${host}/${company}/${postingId}/apply`);
  return {
    passed: true,
    normalizedUrl: normalized.href,
    host,
    company,
    postingId,
    warnings,
    failureReason: null,
  };
}

export function isTrustedLeverHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return ALLOWED_HOSTS.has(host);
  } catch {
    return false;
  }
}
