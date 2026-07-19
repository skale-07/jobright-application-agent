/**
 * Sanitization helpers for JobRight live captures (recorder CLI in Phase 2b).
 * Phase 1 ships the pure transforms so fixtures never retain secrets.
 */

const SECRET_ATTRS = new Set([
  "value",
  "data-token",
  "data-auth",
  "autocomplete",
]);

const REDACT_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /(?:cookie|authorization|x-csrf-token)\s*[:=]\s*[^\s"'<>]+/gi,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  // Extra secret patterns (Phase 5.5 hardening)
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\bsk-(?:live|test|proj)?[-_]?[A-Za-z0-9]{20,}\b/g,
  /(?:api[_-]?key|secret[_-]?key|access[_-]?token)\s*[:=]\s*['"]?[^\s"'<>]{8,}/gi,
  /(?:password|passwd|pwd)\s*[:=]\s*['"]?[^\s"'<>]{4,}/gi,
  /\b\d{3}-\d{2}-\d{4}\b/g, // SSN-shaped
];

export type SanitizeOptions = {
  redactEmails?: boolean;
  redactPhones?: boolean;
};

export function sanitizeText(
  input: string,
  options: SanitizeOptions = {},
): string {
  const redactEmails = options.redactEmails ?? true;
  const redactPhones = options.redactPhones ?? true;
  let out = input;
  for (const re of REDACT_PATTERNS) {
    out = out.replace(re, "[REDACTED]");
  }
  if (!redactEmails) {
    // patterns already applied; keep flag for future selective modes
  }
  if (!redactPhones) {
    // same
  }
  return out;
}

export function sanitizeHtml(html: string, options?: SanitizeOptions): string {
  let out = sanitizeText(html, options);
  // Strip potentially sensitive attribute values
  out = out.replace(
    /\s(value|data-token|data-auth|name="password")\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,
    ' $1="[REDACTED]"',
  );
  // Remove script bodies
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "<script>[REDACTED]</script>");
  return out;
}

export function sanitizeNetworkMetadata(
  entries: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return entries.map((entry) => {
    const headers = entry["headers"];
    const safeHeaders =
      headers && typeof headers === "object"
        ? Object.fromEntries(
            Object.entries(headers as Record<string, unknown>).map(([k, v]) => {
              if (/cookie|auth|token|set-cookie/i.test(k)) {
                return [k, "[REDACTED]"];
              }
              return [k, v];
            }),
          )
        : headers;
    return {
      ...entry,
      headers: safeHeaders,
      body: entry["body"] !== undefined ? "[REDACTED]" : undefined,
      postData: entry["postData"] !== undefined ? "[REDACTED]" : undefined,
      url:
        typeof entry["url"] === "string"
          ? sanitizeText(entry["url"] as string, { redactEmails: true })
          : entry["url"],
    };
  });
}

export function isSensitiveAttr(name: string): boolean {
  return SECRET_ATTRS.has(name.toLowerCase()) || /token|auth|cookie/i.test(name);
}
