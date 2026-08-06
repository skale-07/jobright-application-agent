import { isTrustedGreenhouseHost } from "./urlValidation.js";

export type FinalNavigationVerification = {
  passed: boolean;
  requestedUrl: string;
  finalUrl: string;
  requestedHost: string | null;
  finalHost: string | null;
  remainedOnTrustedGreenhouseHost: boolean;
  redirectObserved: boolean;
  failureCode: "GREENHOUSE_APPLICATION_UNAVAILABLE" | "UNSAFE_FINAL_URL" | null;
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
 * Evaluate the page after navigation. Untrusted final hosts fail closed
 * before any semantic page-text classification.
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

  if (!remainedOnTrustedGreenhouseHost) {
    return {
      passed: false,
      requestedUrl: input.requestedUrl,
      finalUrl: input.finalUrl,
      requestedHost,
      finalHost,
      remainedOnTrustedGreenhouseHost: false,
      redirectObserved,
      failureCode: "GREENHOUSE_APPLICATION_UNAVAILABLE",
      failureReason:
        "The Greenhouse application is no longer available at the requested URL. " +
        "The page redirected outside the supported Greenhouse application host.",
    };
  }

  return {
    passed: true,
    requestedUrl: input.requestedUrl,
    finalUrl: input.finalUrl,
    requestedHost,
    finalHost,
    remainedOnTrustedGreenhouseHost: true,
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
