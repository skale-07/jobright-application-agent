import type { LoginWallDetection } from "./loginWallDetection.js";

export type GreenhouseFailureCode =
  | "CAPTCHA"
  | "LOGIN_WALL"
  | "APPLICATION_CLOSED"
  | "ERROR_PAGE"
  | "GREENHOUSE_APPLICATION_UNAVAILABLE"
  | "UNSAFE_FINAL_URL"
  | "JOB_ID_MISMATCH"
  | "FORM_NOT_FOUND"
  | "ZERO_FIELDS"
  | "ATS_MISMATCH"
  | null;

export type GreenhouseIdentityVerification = {
  passed: boolean;
  requestedUrl: string;
  finalUrl: string;
  requestedJobId: string | null;
  observedJobId: string | null;
  company: string | null;
  role: string | null;
  formDetected: boolean;
  fieldCount: number;
  failureCode: GreenhouseFailureCode;
  warnings: string[];
  failureReason: string | null;
};

/**
 * Identity checks AFTER final navigation has already confirmed a trusted
 * Greenhouse host. Precedence (within this function):
 * CAPTCHA → HIGH-confidence login wall → closed → error → id mismatch →
 * missing form → zero fields → pass
 */
export function verifyGreenhousePageIdentity(input: {
  requestedUrl: string;
  finalUrl: string;
  requestedJobId: string | null;
  observedJobId: string | null;
  company: string | null;
  role: string | null;
  formDetected: boolean;
  fieldCount: number;
  captchaDetected: boolean;
  loginWall: LoginWallDetection;
  closedJobDetected: boolean;
  errorPageDetected: boolean;
}): GreenhouseIdentityVerification {
  const warnings: string[] = [];
  const base = {
    requestedUrl: input.requestedUrl,
    finalUrl: input.finalUrl,
    requestedJobId: input.requestedJobId,
    observedJobId: input.observedJobId,
    company: input.company,
    role: input.role,
    formDetected: input.formDetected,
    fieldCount: input.fieldCount,
    warnings,
  };

  if (
    input.loginWall.confidence === "MEDIUM" ||
    input.loginWall.confidence === "LOW"
  ) {
    if (input.loginWall.signals.length > 0) {
      warnings.push(
        `login_wall_${input.loginWall.confidence.toLowerCase()}: ${input.loginWall.signals.join(",")}`,
      );
    }
  }

  if (input.captchaDetected) {
    return {
      ...base,
      passed: false,
      failureCode: "CAPTCHA",
      failureReason: "CAPTCHA detected. Inspection stopped.",
    };
  }

  if (input.loginWall.detected && input.loginWall.confidence === "HIGH") {
    return {
      ...base,
      passed: false,
      failureCode: "LOGIN_WALL",
      failureReason: "Login wall detected. Inspection stopped.",
    };
  }

  if (input.closedJobDetected) {
    return {
      ...base,
      passed: false,
      failureCode: "APPLICATION_CLOSED",
      failureReason:
        "Application appears closed (explicit closed-job signal on Greenhouse).",
    };
  }

  if (input.errorPageDetected) {
    return {
      ...base,
      passed: false,
      failureCode: "ERROR_PAGE",
      failureReason: "Error page detected.",
    };
  }

  if (
    input.requestedJobId &&
    input.observedJobId &&
    input.requestedJobId !== input.observedJobId
  ) {
    return {
      ...base,
      passed: false,
      failureCode: "JOB_ID_MISMATCH",
      failureReason: `Job ID mismatch: requested ${input.requestedJobId}, observed ${input.observedJobId}`,
    };
  }

  if (!input.formDetected) {
    return {
      ...base,
      passed: false,
      formDetected: false,
      failureCode: "FORM_NOT_FOUND",
      failureReason:
        "No Greenhouse application form was found on the trusted host.",
    };
  }

  if (input.fieldCount < 1) {
    return {
      ...base,
      passed: false,
      fieldCount: 0,
      failureCode: "ZERO_FIELDS",
      failureReason: "Zero application fields discovered.",
    };
  }

  if (!input.observedJobId && input.requestedJobId) {
    warnings.push("Could not parse job id from final URL; using requested id");
  }

  return {
    ...base,
    passed: true,
    observedJobId: input.observedJobId ?? input.requestedJobId,
    failureCode: null,
    failureReason: null,
  };
}

export function detectClosedJobSignals(html: string, title: string): boolean {
  const t = `${title}\n${html}`.toLowerCase();
  return /job (is )?closed|no longer accepting|position has been filled|this job is no longer available/.test(
    t,
  );
}

export function detectErrorPageSignals(html: string, title: string): boolean {
  const t = `${title}\n${html}`.slice(0, 8000).toLowerCase();
  return /something went wrong|internal server error|access denied|forbidden/.test(
    t,
  );
}

export function extractGreenhouseJobIdFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const pathJob = u.pathname.match(/\/jobs\/(\d+)/i);
    if (pathJob?.[1]) return pathJob[1];
    // Embed: ?token=<jobId> or ?gh_jid=
    const token = u.searchParams.get("token") ?? u.searchParams.get("gh_jid");
    if (token && /^\d+$/.test(token)) return token;
    return null;
  } catch {
    return null;
  }
}

export function extractBoardTokenFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const pathBoard = u.pathname.match(
      /^\/([a-z0-9][a-z0-9_-]*)\/jobs\//i,
    );
    if (pathBoard?.[1] && pathBoard[1].toLowerCase() !== "embed") {
      return pathBoard[1];
    }
    // Embed: ?for=<boardToken>
    const forParam = u.searchParams.get("for");
    if (forParam && /^[a-z0-9][a-z0-9_-]*$/i.test(forParam)) return forParam;
    return null;
  } catch {
    return null;
  }
}
