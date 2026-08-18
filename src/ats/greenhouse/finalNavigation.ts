import { isTrustedGreenhouseHost } from "./urlValidation.js";

export type FinalNavigationVerification = {
  passed: boolean;
  requestedUrl: string;
  finalUrl: string;
  requestedHost: string | null;
  finalHost: string | null;
  remainedOnTrustedGreenhouseHost: boolean;
  redirectObserved: boolean;
  failureCode: "UNSAFE_FINAL_URL" | null;
  failureReason: string | null;
};

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Record where navigation landed. Host is never a fill/inspect gate.
 * Greenhouse boards routinely 302 onto the employer's own careers host
 * (`/hr/job?gh_jid=…`, `?gh_jid=` on careers.example.com). That is still
 * the same application. Captcha, login wall, closed-job, form, and field
 * checks decide. Only an unparseable final URL fails here.
 */
export function verifyFinalNavigation(input: {
  requestedUrl: string;
  finalUrl: string;
}): FinalNavigationVerification {
  const requestedHost = hostOf(input.requestedUrl);
  let finalHost: string | null = null;
  try {
    finalHost = new URL(input.finalUrl).hostname.toLowerCase();
  } catch {
    return {
      passed: false,
      requestedUrl: input.requestedUrl,
      finalUrl: input.finalUrl,
      requestedHost,
      finalHost: null,
      remainedOnTrustedGreenhouseHost: false,
      redirectObserved: true,
      failureCode: "UNSAFE_FINAL_URL",
      failureReason: "Final URL is malformed or unparseable.",
    };
  }

  const redirectObserved =
    Boolean(requestedHost && finalHost && requestedHost !== finalHost) ||
    normalizeUrlKey(input.requestedUrl) !== normalizeUrlKey(input.finalUrl);

  const remainedOnTrustedGreenhouseHost = isTrustedGreenhouseHost(
    input.finalUrl,
  );

  return {
    passed: true,
    requestedUrl: input.requestedUrl,
    finalUrl: input.finalUrl,
    requestedHost,
    finalHost,
    remainedOnTrustedGreenhouseHost,
    redirectObserved,
    failureCode: null,
    failureReason: null,
  };
}

function normalizeUrlKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return `${u.protocol}//${u.hostname.toLowerCase()}${u.pathname.replace(/\/+$/, "") || "/"}`;
  } catch {
    return url.trim().toLowerCase();
  }
}
