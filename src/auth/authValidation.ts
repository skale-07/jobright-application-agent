import type { Page } from "playwright";
import type { AuthValidationResult, ServiceAuthConfig } from "./types.js";

export function matchUrlPatterns(url: string, patterns: RegExp[]): RegExp | undefined {
  return patterns.find((p) => p.test(url));
}

export async function validateAuthFromPage(
  page: Page,
  config: ServiceAuthConfig,
): Promise<AuthValidationResult> {
  const url = page.url();
  const checkedAt = new Date().toISOString();

  const checkpoint = matchUrlPatterns(url, config.checkpointUrlPatterns);
  if (checkpoint) {
    return {
      ok: false,
      status: "CHECKPOINT",
      url,
      reason: `Checkpoint/challenge URL matched ${checkpoint}`,
      checkedAt,
    };
  }

  const unauth = matchUrlPatterns(url, config.unauthenticatedUrlPatterns);
  if (unauth) {
    return {
      ok: false,
      status: "UNAUTHENTICATED",
      url,
      reason: `Unauthenticated URL matched ${unauth}`,
      checkedAt,
    };
  }

  if (config.validateExtra) {
    const extra = await config.validateExtra(page);
    if (extra) return extra;
  }

  return {
    ok: true,
    status: "AUTHENTICATED",
    url,
    reason: "No login/checkpoint URL patterns matched",
    checkedAt,
  };
}

/** Pure helper for unit tests / mid-run redirect checks. */
export function classifyAuthUrl(
  url: string,
  config: Pick<
    ServiceAuthConfig,
    "unauthenticatedUrlPatterns" | "checkpointUrlPatterns"
  >,
): AuthValidationResult {
  const checkedAt = new Date().toISOString();
  const checkpoint = matchUrlPatterns(url, config.checkpointUrlPatterns);
  if (checkpoint) {
    return {
      ok: false,
      status: "CHECKPOINT",
      url,
      reason: `Checkpoint/challenge URL matched ${checkpoint}`,
      checkedAt,
    };
  }
  const unauth = matchUrlPatterns(url, config.unauthenticatedUrlPatterns);
  if (unauth) {
    return {
      ok: false,
      status: "UNAUTHENTICATED",
      url,
      reason: `Unauthenticated URL matched ${unauth}`,
      checkedAt,
    };
  }
  return {
    ok: true,
    status: "AUTHENTICATED",
    url,
    reason: "No login/checkpoint URL patterns matched",
    checkedAt,
  };
}
