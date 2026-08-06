import { extractJobIdFromUrl } from "./jobDetails.js";
import { jobrightSelectorsV1 } from "./selectors/v1.js";

export const JOBRIGHT_TRUSTED_ORIGIN = "https://jobright.ai";

const HEX_JOB_ID = /^[a-f0-9]{8,64}$/i;

export function isValidJobrightJobId(jobId: string): boolean {
  return HEX_JOB_ID.test(jobId.trim());
}

export type TrustedJobUrlResult =
  | { ok: true; url: string; jobPath: string; jobrightJobId: string }
  | { ok: false; reason: string };

/**
 * Validate a JobRight job detail URL for read-only inspection.
 * Rejects non-HTTPS, non-JobRight hosts, javascript/data URLs, and ID mismatches.
 */
export function validateJobRightInspectionUrl(
  rawUrl: string,
  expectedJobrightJobId: string,
): TrustedJobUrlResult {
  const expected = expectedJobrightJobId.trim();
  if (!isValidJobrightJobId(expected)) {
    return { ok: false, reason: `Malformed jobright job id: ${expected}` };
  }

  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { ok: false, reason: "Empty job URL" };
  }
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith("javascript:") ||
    lower.startsWith("data:") ||
    lower.startsWith("file:") ||
    lower.startsWith("vbscript:")
  ) {
    return { ok: false, reason: `Forbidden URL scheme: ${trimmed.slice(0, 32)}` };
  }

  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return { ok: false, reason: `Malformed URL: ${trimmed}` };
  }

  if (u.protocol !== "https:") {
    return { ok: false, reason: `Non-HTTPS URL rejected: ${u.protocol}` };
  }
  if (u.username || u.password) {
    return { ok: false, reason: "URLs with credentials are rejected" };
  }
  if (u.hostname.toLowerCase() !== "jobright.ai") {
    return { ok: false, reason: `Non-JobRight host rejected: ${u.hostname}` };
  }

  const parsedId = extractJobIdFromUrl(u.href);
  if (!parsedId) {
    return {
      ok: false,
      reason: `URL is not a JobRight job detail path: ${u.pathname}`,
    };
  }
  if (parsedId.toLowerCase() !== expected.toLowerCase()) {
    return {
      ok: false,
      reason: `Path job id ${parsedId} does not match requested ${expected}`,
    };
  }

  const prefix = jobrightSelectorsV1.urls.jobInfoPathPrefix;
  const jobPath = `${prefix}${parsedId}`;
  // Drop query/hash — inspection uses canonical detail path only
  const url = `${JOBRIGHT_TRUSTED_ORIGIN}${jobPath}`;
  return { ok: true, url, jobPath, jobrightJobId: parsedId };
}

/**
 * Build https://jobright.ai/jobs/info/<id> when no persisted URL exists.
 */
export function buildJobRightDetailUrlFromId(
  jobrightJobId: string,
): TrustedJobUrlResult {
  const id = jobrightJobId.trim();
  if (!isValidJobrightJobId(id)) {
    return { ok: false, reason: `Malformed jobright job id: ${id}` };
  }
  const jobPath = `${jobrightSelectorsV1.urls.jobInfoPathPrefix}${id}`;
  return validateJobRightInspectionUrl(
    `${JOBRIGHT_TRUSTED_ORIGIN}${jobPath}`,
    id,
  );
}

/**
 * Choose canonical inspection URL: persisted URL → path → construct from id.
 */
export function resolveCanonicalInspectionUrl(input: {
  jobrightJobId: string;
  persistedUrl: string | null;
  jobPath: string | null;
}): TrustedJobUrlResult {
  const id = input.jobrightJobId.trim();
  if (input.persistedUrl) {
    const fromPersisted = validateJobRightInspectionUrl(input.persistedUrl, id);
    if (fromPersisted.ok) return fromPersisted;
    // Fall through if persisted value is ATS/external — try path/id
  }
  if (input.jobPath) {
    const path = input.jobPath.startsWith("/")
      ? input.jobPath
      : `/${input.jobPath}`;
    const fromPath = validateJobRightInspectionUrl(
      `${JOBRIGHT_TRUSTED_ORIGIN}${path}`,
      id,
    );
    if (fromPath.ok) return fromPath;
  }
  return buildJobRightDetailUrlFromId(id);
}
