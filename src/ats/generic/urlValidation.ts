/**
 * Generic employer application URLs — any company-hosted form.
 *
 * Most employers do not use one of the five hosted ATS products. In the
 * live corpus, 10 of 41 resolved URLs had no supported ATS and every one
 * was a DIFFERENT host (tesla.com, citadel.com, careers.ibm.com,
 * jobs.jobvite.com, jobs.gusto.com, ycombinator.com) — a pure long tail
 * that adding vendors one at a time never catches up with.
 *
 * TRUST MODEL (operator directive 2026-08-13). A URL reaching this
 * validator is not arbitrary input: it came from a JobRight posting the
 * operator queued, was resolved by navigation, and passed the congruence
 * check that verifies the employer's name against the URL's host or path
 * (src/navigation/congruence.ts). That provenance IS the trust decision.
 * This validator therefore does NOT re-litigate it with a host allowlist —
 * it enforces only the two invariants that provenance cannot supply:
 * transport (https) and "not JobRight's own site".
 *
 * Every downstream gate is unchanged: FORM_FILL_ENABLED / SUBMIT_ENABLED,
 * the approved-plan assertion, the essay and demographic non-fill rules,
 * the required-completeness scan, and the uncertain-submission path all
 * apply to a generic host exactly as they do to Greenhouse.
 */

export type GenericUrlValidation = {
  passed: boolean;
  normalizedUrl: string | null;
  warnings: string[];
  failureReason: string | null;
};

/** Query keys that are tracking noise, not application identity. */
const TRACKING_PARAMS = [
  "jr_id",
  "src",
  "source",
  "gh_src",
  "ref",
  "referrer",
  "trackingid",
  "trk",
];

/**
 * Hosts owned by a vendor whose own validator runs BEFORE this one. If
 * such a URL reaches here, that vendor REJECTED it (malformed posting id,
 * wrong path shape) — and a vendor rejection must stay a rejection.
 * Downgrading it to generic would fill a Lever/Ashby form with structural
 * heuristics while the real adapter, with its combobox and typeahead
 * handling, sits unused. Caught by test on first run.
 */
const VENDOR_OWNED_HOSTS = [
  "greenhouse.io",
  "lever.co",
  "ashbyhq.com",
  "workable.com",
  "myworkdayjobs.com",
];

export function validateGenericApplicationUrl(
  raw: string,
): GenericUrlValidation {
  const warnings: string[] = [];
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return {
      passed: false,
      normalizedUrl: null,
      warnings,
      failureReason: "unparseable URL",
    };
  }
  if (parsed.protocol !== "https:") {
    return {
      passed: false,
      normalizedUrl: null,
      warnings,
      failureReason: `not https (${parsed.protocol})`,
    };
  }
  const host = parsed.hostname.toLowerCase();
  if (!host || !host.includes(".")) {
    return {
      passed: false,
      normalizedUrl: null,
      warnings,
      failureReason: `not a public hostname (${host || "empty"})`,
    };
  }
  if (/(^|\.)jobright\.ai$/i.test(host)) {
    return {
      passed: false,
      normalizedUrl: null,
      warnings,
      failureReason: "jobright-hosted — the operator's own session, not an employer form",
    };
  }

  const vendorHost = VENDOR_OWNED_HOSTS.find(
    (h) => host === h || host.endsWith(`.${h}`),
  );
  if (vendorHost) {
    return {
      passed: false,
      normalizedUrl: null,
      warnings,
      failureReason: `${vendorHost} is a supported ATS host whose own validator rejected this URL — not downgrading to generic heuristics`,
    };
  }

  const normalized = new URL(parsed.toString());
  normalized.hash = "";
  for (const key of [...normalized.searchParams.keys()]) {
    if (TRACKING_PARAMS.includes(key.toLowerCase()) || /^utm_/i.test(key)) {
      normalized.searchParams.delete(key);
    }
  }
  // A bare host with no path is a careers landing page, not a form. It is
  // allowed through (the page gate decides on the real DOM), but say so.
  if (normalized.pathname === "/" || normalized.pathname === "") {
    warnings.push("URL has no path — this may be a careers landing page, not an application form");
  }
  return {
    passed: true,
    normalizedUrl: normalized.toString(),
    warnings,
    failureReason: null,
  };
}

/**
 * Same-origin invariance: whatever host the stored employer URL names, the
 * page we mutate must still be on it. This is not an allowlist — it is the
 * one host claim provenance can make, and it is what stops a mid-flow
 * redirect swapping the page under an approved fill plan.
 */
export function isSameEmployerOrigin(
  expectedUrl: string,
  finalUrl: string,
): boolean {
  try {
    const a = new URL(expectedUrl).hostname.toLowerCase();
    const b = new URL(finalUrl).hostname.toLowerCase();
    if (a === b) return true;
    // www.acme.com ⇄ acme.com ⇄ careers.acme.com are the same employer.
    const registrable = (h: string): string => h.split(".").slice(-2).join(".");
    return registrable(a) === registrable(b);
  } catch {
    return false;
  }
}
