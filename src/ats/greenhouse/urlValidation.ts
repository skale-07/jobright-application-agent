/**
 * Strict Greenhouse application URL validation for live read-only inspection.
 */

const ALLOWED_HOSTS = new Set([
  "boards.greenhouse.io",
  "job-boards.greenhouse.io",
]);

/** /<boardToken>/jobs/<jobId> with optional trailing slash / query */
const JOB_PATH =
  /^\/([a-z0-9][a-z0-9_-]*)\/jobs\/(\d+)(?:\/)?$/i;

/**
 * JobRight-style embed application page:
 * /embed/job_app?for=<boardToken>&token=<jobId>[&jr_id=...]
 */
const EMBED_PATH = /^\/embed\/job_app\/?$/i;

export type GreenhouseUrlValidation = {
  passed: boolean;
  normalizedUrl: string | null;
  host: string | null;
  boardToken: string | null;
  greenhouseJobId: string | null;
  warnings: string[];
  failureReason: string | null;
};

function fail(
  reason: string,
  warnings: string[] = [],
): GreenhouseUrlValidation {
  return {
    passed: false,
    normalizedUrl: null,
    host: null,
    boardToken: null,
    greenhouseJobId: null,
    warnings,
    failureReason: reason,
  };
}

/**
 * Validate and normalize a Greenhouse job/application URL.
 * Rejects marketing pages, non-HTTPS, credentials, unexpected hosts/ports.
 * Accepts classic /board/jobs/id paths and JobRight embed /embed/job_app?for=&token=.
 */
export function validateGreenhouseApplicationUrl(
  rawUrl: string,
): GreenhouseUrlValidation {
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
    if (/greenhouse\.io$/i.test(host) || /grnh\.se$/i.test(host)) {
      return fail(
        `Greenhouse host not allowlisted for application inspection: ${host}`,
      );
    }
    return fail(`Non-Greenhouse host rejected: ${host}`);
  }

  // Homepage / marketing
  const path = u.pathname.replace(/\/+$/, "") || "/";
  if (path === "/" || path === "") {
    return fail("Greenhouse homepage / root URL rejected");
  }
  if (/^\/(about|pricing|customers|login|signup|blog)/i.test(path)) {
    return fail("Greenhouse marketing or auth path rejected");
  }

  // JobRight / partner embed application.
  if (EMBED_PATH.test(u.pathname)) {
    const boardToken = (u.searchParams.get("for") ?? "").trim();
    const greenhouseJobId = (
      u.searchParams.get("token") ??
      u.searchParams.get("gh_jid") ??
      ""
    ).trim();
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(boardToken)) {
      return fail(
        "Embed job_app URL missing or invalid board token (?for=...)",
      );
    }
    if (!/^\d+$/.test(greenhouseJobId)) {
      return fail(
        "Embed job_app URL missing or invalid job id (?token=<numeric job id>)",
      );
    }
    warnings.push("embed_job_app_url");
    // Classic board/jobs path is the stable join identity for extractors.
    const normalized = new URL(
      `https://${host}/${boardToken}/jobs/${greenhouseJobId}`,
    );
    return {
      passed: true,
      normalizedUrl: normalized.href,
      host,
      boardToken,
      greenhouseJobId,
      warnings,
      failureReason: null,
    };
  }

  const pathMatch = u.pathname.match(JOB_PATH);
  if (!pathMatch) {
    return fail(
      `URL is not a recognizable Greenhouse job application path: ${u.pathname}`,
    );
  }

  const boardToken = pathMatch[1]!;
  const greenhouseJobId = pathMatch[2]!;

  const ghJid = u.searchParams.get("gh_jid");
  if (ghJid && ghJid !== greenhouseJobId) {
    return fail(
      `Query gh_jid=${ghJid} does not match path job id ${greenhouseJobId}`,
    );
  }
  if (ghJid && ghJid === greenhouseJobId) {
    warnings.push("gh_jid query matches path job id");
  }

  // Drop tracking params for normalized URL
  const normalized = new URL(
    `https://${host}/${boardToken}/jobs/${greenhouseJobId}`,
  );
  return {
    passed: true,
    normalizedUrl: normalized.href,
    host,
    boardToken,
    greenhouseJobId,
    warnings,
    failureReason: null,
  };
}

export function isTrustedGreenhouseHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return ALLOWED_HOSTS.has(host);
  } catch {
    return false;
  }
}
