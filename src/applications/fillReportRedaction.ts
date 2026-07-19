import { maskEmail, maskPhone, redactObject } from "../logging/redaction.js";

const EMAIL_KEY = /^email$/i;
const PHONE_KEY = /^phone$/i;
const SPONSORSHIP_KEY =
  /(requires_sponsorship|sponsorship|work_authorization)/i;
const PATH_KEY = /(^path$|report_path|resume_path|cover_letter_path|filename|file_path)/i;

/**
 * Redact fill plans/reports for CLI output and artifacts.
 * Email, phone, sponsorship/work-auth, and filesystem paths become placeholders.
 */
export function redactFillReportForArtifact(
  input: unknown,
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { value: "[REDACTED]" };
  }
  return walk(input as Record<string, unknown>);
}

function walk(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = redactNode(key, value);
  }
  return out;
}

function redactNode(key: string, value: unknown): unknown {
  if (EMAIL_KEY.test(key)) {
    return typeof value === "string" && value
      ? maskEmail(value)
      : value
        ? "[REDACTED_EMAIL]"
        : value;
  }
  if (PHONE_KEY.test(key)) {
    return typeof value === "string" && value
      ? maskPhone(value)
      : value
        ? "[REDACTED_PHONE]"
        : value;
  }
  if (SPONSORSHIP_KEY.test(key)) {
    return value === null || value === undefined || value === ""
      ? value
      : "[REDACTED_SPONSORSHIP]";
  }
  if (PATH_KEY.test(key)) {
    return value === null || value === undefined || value === ""
      ? value
      : "[REDACTED_PATH]";
  }

  // answers / snapshots keyed by canonical field name
  if (
    (key === "answers" || key === "filled" || key === "snapshot") &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    return redactAnswersMap(value as Record<string, unknown>);
  }

  if (Array.isArray(value)) {
    return value.map((item, i) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        return redactPlanEntry(item as Record<string, unknown>);
      }
      return redactNode(String(i), item);
    });
  }

  if (value && typeof value === "object") {
    return walk(value as Record<string, unknown>);
  }

  return value;
}

function redactAnswersMap(
  map: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(map)) {
    out[k] = redactNode(k, v);
  }
  return out;
}

function redactPlanEntry(
  entry: Record<string, unknown>,
): Record<string, unknown> {
  const cloned = walk(entry);
  const canonical =
    typeof entry["canonical_field"] === "string"
      ? entry["canonical_field"]
      : "";
  if (/email|phone|sponsor|work_authorization/i.test(canonical)) {
    for (const field of ["value", "expected", "observed"] as const) {
      if (cloned[field] != null && cloned[field] !== "") {
        if (/email/i.test(canonical) && typeof cloned[field] === "string") {
          cloned[field] = maskEmail(cloned[field]);
        } else if (
          /phone/i.test(canonical) &&
          typeof cloned[field] === "string"
        ) {
          cloned[field] = maskPhone(cloned[field]);
        } else if (/sponsor|work_authorization/i.test(canonical)) {
          cloned[field] = "[REDACTED_SPONSORSHIP]";
        } else {
          cloned[field] = "[REDACTED]";
        }
      }
    }
  }
  return cloned;
}

/** Fill-specific redaction then general logger redaction. */
export function redactFillReportDeep(input: unknown): Record<string, unknown> {
  return redactObject(redactFillReportForArtifact(input));
}
