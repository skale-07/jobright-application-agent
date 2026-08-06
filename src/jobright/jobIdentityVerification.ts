import { normalizeWhitespace } from "../jobs/fingerprint.js";
import { extractJobIdFromUrl } from "./jobDetails.js";
import { jobrightSelectorsV1 } from "./selectors/v1.js";

export type JobIdentityVerification = {
  passed: boolean;
  requestedJobrightJobId: string;
  finalUrl: string;
  parsedJobrightJobId: string | null;
  storedCompany: string | null;
  visibleCompany: string | null;
  storedRole: string | null;
  visibleRole: string | null;
  warnings: string[];
  failureReason: string | null;
};

function rolesMateriallyDifferent(stored: string, visible: string): boolean {
  const a = normalizeWhitespace(stored);
  const b = normalizeWhitespace(visible);
  if (a === b) return false;
  if (a.includes(b) || b.includes(a)) return false;
  // Token Jaccard — low overlap ⇒ material difference
  const ta = new Set(a.split(" ").filter((t) => t.length > 2));
  const tb = new Set(b.split(" ").filter((t) => t.length > 2));
  if (ta.size === 0 || tb.size === 0) return a !== b;
  let inter = 0;
  for (const t of ta) {
    if (tb.has(t)) inter += 1;
  }
  const union = ta.size + tb.size - inter;
  return inter / union < 0.35;
}

function companiesConflict(stored: string, visible: string): boolean {
  const a = normalizeWhitespace(stored);
  const b = normalizeWhitespace(visible);
  if (a === b) return false;
  if (a.includes(b) || b.includes(a)) return false;
  return true;
}

/**
 * Classify final URL redirects that must abort control inspection.
 */
export function classifyInspectionRedirect(
  finalUrl: string,
  requestedJobrightJobId: string,
): { kind: "ok" | "fail"; reason: string | null } {
  let u: URL;
  try {
    u = new URL(finalUrl);
  } catch {
    return { kind: "fail", reason: `Unparseable final URL: ${finalUrl}` };
  }

  const host = u.hostname.toLowerCase();
  const path = u.pathname.toLowerCase();

  if (host !== "jobright.ai" && !finalUrl.startsWith("file:")) {
    return {
      kind: "fail",
      reason: `External or unexpected host redirect: ${host}`,
    };
  }

  if (
    /login|sign-?in|auth|oauth|accounts\.google/i.test(finalUrl) ||
    path.includes("/login")
  ) {
    return { kind: "fail", reason: "Redirected to login / auth wall" };
  }

  if (
    path === "/" ||
    path === "" ||
    path.startsWith("/jobs/recommend") ||
    path === "/jobs" ||
    path === "/jobs/"
  ) {
    return {
      kind: "fail",
      reason: "Redirected to homepage or recommendation feed",
    };
  }

  if (
    /greenhouse\.io|lever\.co|myworkdayjobs|workday\.com|ashbyhq\.com/i.test(
      finalUrl,
    )
  ) {
    return { kind: "fail", reason: "Redirected to external ATS" };
  }

  if (/\/jobs\/info\//i.test(path)) {
    const parsed = extractJobIdFromUrl(finalUrl);
    if (parsed && parsed.toLowerCase() !== requestedJobrightJobId.toLowerCase()) {
      return {
        kind: "fail",
        reason: `Redirected to a different job (${parsed})`,
      };
    }
  } else if (!finalUrl.startsWith("file:")) {
    // Non-detail JobRight path (e.g. error)
    if (!path.includes(jobrightSelectorsV1.urls.jobInfoPathPrefix)) {
      return {
        kind: "fail",
        reason: `Unexpected JobRight path (not job detail): ${u.pathname}`,
      };
    }
  }

  return { kind: "ok", reason: null };
}

export function verifyJobIdentity(input: {
  requestedJobrightJobId: string;
  finalUrl: string;
  parsedJobrightJobId: string | null;
  storedCompany: string | null;
  visibleCompany: string | null;
  storedRole: string | null;
  visibleRole: string | null;
}): JobIdentityVerification {
  const warnings: string[] = [];
  const redirect = classifyInspectionRedirect(
    input.finalUrl,
    input.requestedJobrightJobId,
  );
  if (redirect.kind === "fail") {
    return {
      passed: false,
      requestedJobrightJobId: input.requestedJobrightJobId,
      finalUrl: input.finalUrl,
      parsedJobrightJobId: input.parsedJobrightJobId,
      storedCompany: input.storedCompany,
      visibleCompany: input.visibleCompany,
      storedRole: input.storedRole,
      visibleRole: input.visibleRole,
      warnings,
      failureReason: redirect.reason,
    };
  }

  if (!input.parsedJobrightJobId) {
    return {
      passed: false,
      requestedJobrightJobId: input.requestedJobrightJobId,
      finalUrl: input.finalUrl,
      parsedJobrightJobId: null,
      storedCompany: input.storedCompany,
      visibleCompany: input.visibleCompany,
      storedRole: input.storedRole,
      visibleRole: input.visibleRole,
      warnings,
      failureReason: "Could not parse jobright_job_id from page/URL",
    };
  }

  if (
    input.parsedJobrightJobId.toLowerCase() !==
    input.requestedJobrightJobId.toLowerCase()
  ) {
    return {
      passed: false,
      requestedJobrightJobId: input.requestedJobrightJobId,
      finalUrl: input.finalUrl,
      parsedJobrightJobId: input.parsedJobrightJobId,
      storedCompany: input.storedCompany,
      visibleCompany: input.visibleCompany,
      storedRole: input.storedRole,
      visibleRole: input.visibleRole,
      warnings,
      failureReason: `Job ID mismatch: requested ${input.requestedJobrightJobId}, observed ${input.parsedJobrightJobId}`,
    };
  }

  if (input.storedCompany && input.visibleCompany) {
    if (companiesConflict(input.storedCompany, input.visibleCompany)) {
      return {
        passed: false,
        requestedJobrightJobId: input.requestedJobrightJobId,
        finalUrl: input.finalUrl,
        parsedJobrightJobId: input.parsedJobrightJobId,
        storedCompany: input.storedCompany,
        visibleCompany: input.visibleCompany,
        storedRole: input.storedRole,
        visibleRole: input.visibleRole,
        warnings,
        failureReason: `Company conflict: stored "${input.storedCompany}" vs visible "${input.visibleCompany}"`,
      };
    }
    if (input.storedCompany.trim() !== input.visibleCompany.trim()) {
      warnings.push("Company text differs by whitespace or formatting");
    }
  } else if (input.storedCompany && !input.visibleCompany) {
    warnings.push("Visible company not found on page");
  }

  if (input.storedRole && input.visibleRole) {
    if (rolesMateriallyDifferent(input.storedRole, input.visibleRole)) {
      return {
        passed: false,
        requestedJobrightJobId: input.requestedJobrightJobId,
        finalUrl: input.finalUrl,
        parsedJobrightJobId: input.parsedJobrightJobId,
        storedCompany: input.storedCompany,
        visibleCompany: input.visibleCompany,
        storedRole: input.storedRole,
        visibleRole: input.visibleRole,
        warnings,
        failureReason: `Role conflict: stored "${input.storedRole}" vs visible "${input.visibleRole}"`,
      };
    }
    if (input.storedRole.trim() !== input.visibleRole.trim()) {
      warnings.push("Role text differs by whitespace or formatting");
    }
  } else if (input.storedRole && !input.visibleRole) {
    warnings.push("Visible role not found on page");
  }

  return {
    passed: true,
    requestedJobrightJobId: input.requestedJobrightJobId,
    finalUrl: input.finalUrl,
    parsedJobrightJobId: input.parsedJobrightJobId,
    storedCompany: input.storedCompany,
    visibleCompany: input.visibleCompany,
    storedRole: input.storedRole,
    visibleRole: input.visibleRole,
    warnings,
    failureReason: null,
  };
}
