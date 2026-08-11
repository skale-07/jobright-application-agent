/**
 * Strict Workday application URL validation. Same rejection battery as the
 * other validators (scheme, credentials, port, host shape, marketing
 * paths) with Workday's multi-tenant URL shapes:
 *   - <tenant>.wd<N>.myworkdayjobs.com/[<locale>/]<site>/job/[<location>/]<Slug>_<REQ>(/apply...)?
 *   - .../details/<Slug>_<REQ>  (search-result deep link — normalized)
 * Normalizes to the canonical job posting URL (no /apply suffix, no query):
 * the workday adapter owns clicking Apply from the posting.
 *
 * Live evidence for the shapes: interdigital.wd5.myworkdayjobs.com and
 * medtronic.wd1.myworkdayjobs.com anchors ignored by phase A in sessions
 * 4a7c199b / cc02e067.
 */

const HOST_RE = /^([a-z0-9][a-z0-9-]*)\.(wd\d+)\.myworkdayjobs\.com$/;

/** e.g. en-US, fr-CA, de — optional first path segment. */
const LOCALE_RE = /^[a-z]{2}(?:-[A-Za-z]{2,4})?$/;

/** Job slug segment: <anything>_<requisition id> (R-12345, JR0031966, 25-1234…). */
const SLUG_RE = /^([^/]+)_([A-Za-z0-9][A-Za-z0-9._-]{2,29})$/;

export type WorkdayUrlValidation = {
  passed: boolean;
  normalizedUrl: string | null;
  host: string | null;
  tenant: string | null;
  site: string | null;
  requisitionId: string | null;
  warnings: string[];
  failureReason: string | null;
};

function fail(reason: string, warnings: string[] = []): WorkdayUrlValidation {
  return {
    passed: false,
    normalizedUrl: null,
    host: null,
    tenant: null,
    site: null,
    requisitionId: null,
    warnings,
    failureReason: reason,
  };
}

export function validateWorkdayApplicationUrl(
  rawUrl: string,
): WorkdayUrlValidation {
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
  const hostMatch = host.match(HOST_RE);
  if (!hostMatch) {
    return fail(`Non-Workday host rejected: ${host}`);
  }
  const tenant = hostMatch[1]!;

  const segments = u.pathname.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) {
    return fail("Workday tenant root URL rejected (no job path)");
  }

  // Optional locale prefix.
  let idx = 0;
  if (segments[0] !== undefined && LOCALE_RE.test(segments[0])) idx = 1;

  // Job path: <site>/job/[<location>/]<slug>_<req>  or  <site>/details/<slug>_<req>.
  const site = segments[idx];
  const kind = segments[idx + 1];
  if (!site || !kind || (kind !== "job" && kind !== "details")) {
    return fail(
      `URL is not a recognizable Workday job path: ${u.pathname}`,
    );
  }
  // The slug is the LAST segment before any apply/login suffix.
  const APPLY_SUFFIXES = new Set(["apply", "applymanually", "autofillwithresume", "login", "usewithlinkedin"]);
  let slugIdx = segments.length - 1;
  while (
    slugIdx > idx + 1 &&
    APPLY_SUFFIXES.has(segments[slugIdx]!.toLowerCase())
  ) {
    slugIdx -= 1;
    warnings.push("apply/login suffix stripped — normalized to the posting URL");
  }
  const slug = segments[slugIdx];
  if (!slug || slugIdx < idx + 2) {
    return fail(`Workday job path carries no job slug: ${u.pathname}`);
  }
  const slugMatch = slug.match(SLUG_RE);
  if (!slugMatch) {
    return fail(
      `Workday job slug has no requisition id (want <title>_<req>): ${slug.slice(0, 60)}`,
    );
  }
  if (kind === "details") {
    warnings.push("details deep link accepted as a posting URL");
  }

  const normalizedPath = `/${segments.slice(0, slugIdx + 1).join("/")}`;
  return {
    passed: true,
    normalizedUrl: `https://${host}${normalizedPath}`,
    host,
    tenant,
    site,
    requisitionId: slugMatch[2]!,
    warnings,
    failureReason: null,
  };
}

export function isTrustedWorkdayHost(url: string): boolean {
  try {
    return HOST_RE.test(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}
