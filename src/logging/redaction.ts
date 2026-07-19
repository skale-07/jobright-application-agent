const SENSITIVE_KEY_PATTERN =
  /(password|token|cookie|authorization|storage.?state|ssn|race|ethnicity|gender|sexual|disability|veteran|phone|address|email_body|access_token|requires_sponsorship|sponsorship|work_authorization)/i;

export function redactValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return "[REDACTED]";
  }
  if (typeof value === "string" && looksLikeSecret(value)) {
    return "[REDACTED]";
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => redactValue(String(i), v));
  }
  if (value && typeof value === "object") {
    return redactObject(value as Record<string, unknown>);
  }
  return value;
}

export function redactObject(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = redactValue(k, v);
  }
  return out;
}

function looksLikeSecret(value: string): boolean {
  if (value.length > 40 && /^[A-Za-z0-9\-_.]+$/.test(value)) {
    return true;
  }
  if (value.includes("eyJ") && value.length > 80) {
    return true;
  }
  return false;
}

export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 1) return "[REDACTED_EMAIL]";
  return `${email[0] ?? ""}***${email.slice(at)}`;
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return "[REDACTED_PHONE]";
  return `***-***-${digits.slice(-4)}`;
}
