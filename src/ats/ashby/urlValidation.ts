/**
 * Strict Ashby application URL validation. Same rejection battery as the
 * Greenhouse/Lever validators with Ashby's URL shape:
 * /<org>/<job-uuid>(/application)?. Normalizes to the /application form URL.
 */

const ALLOWED_HOSTS = new Set(["jobs.ashbyhq.com"]);

const JOB_PATH =
  /^\/([a-z0-9][a-z0-9_.%-]*)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/application)?\/?$/i;

export type AshbyUrlValidation = {
  passed: boolean;
  normalizedUrl: string | null;
  host: string | null;
  org: string | null;
  jobId: string | null;
  warnings: string[];
  failureReason: string | null;
};

function fail(reason: string, warnings: string[] = []): AshbyUrlValidation {
  return {
    passed: false,
    normalizedUrl: null,
    host: null,
    org: null,
    jobId: null,
    warnings,
    failureReason: reason,
  };
}

export function validateAshbyApplicationUrl(rawUrl: string): AshbyUrlValidation {
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
    if (/(^|\.)ashbyhq\.com$/i.test(host)) {
      return fail(`Ashby host not allowlisted for application URLs: ${host}`);
    }
    return fail(`Non-Ashby host rejected: ${host}`);
  }

  const path = u.pathname.replace(/\/+$/, "") || "/";
  if (path === "/" || path === "") {
    return fail("Ashby job-board root URL rejected — no job id");
  }

  const pathMatch = u.pathname.match(JOB_PATH);
  if (!pathMatch) {
    return fail(
      `URL is not a recognizable Ashby job/application path: ${u.pathname}`,
    );
  }

  const org = pathMatch[1]!.toLowerCase();
  const jobId = pathMatch[2]!.toLowerCase();
  if (!pathMatch[3]) {
    warnings.push("Job URL without /application — normalized to the form URL");
  }

  const normalized = new URL(`https://${host}/${org}/${jobId}/application`);
  return {
    passed: true,
    normalizedUrl: normalized.href,
    host,
    org,
    jobId,
    warnings,
    failureReason: null,
  };
}

export function isTrustedAshbyHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return ALLOWED_HOSTS.has(host);
  } catch {
    return false;
  }
}
