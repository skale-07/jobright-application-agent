import { createHash } from "node:crypto";

export type JobIdentityInput = {
  jobrightJobId?: string | null;
  applicationUrl?: string | null;
  company: string;
  role: string;
};

export function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function normalizeApplicationUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    u.hash = "";
    // Drop common tracking params
    for (const key of [...u.searchParams.keys()]) {
      if (
        key.toLowerCase().startsWith("utm_") ||
        key.toLowerCase() === "gh_src" ||
        key.toLowerCase() === "source"
      ) {
        u.searchParams.delete(key);
      }
    }
    let path = u.pathname.replace(/\/+$/, "");
    if (path === "") path = "/";
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`.toLowerCase();
  } catch {
    return normalizeWhitespace(url);
  }
}

/**
 * Stable fingerprint for duplicate detection.
 * Prefer JobRight id when present; always include company + role + normalized URL.
 */
export function computeJobFingerprint(input: JobIdentityInput): string {
  const parts = [
    input.jobrightJobId ? normalizeWhitespace(input.jobrightJobId) : "",
    input.applicationUrl
      ? normalizeApplicationUrl(input.applicationUrl)
      : "",
    normalizeWhitespace(input.company),
    normalizeWhitespace(input.role),
  ];
  return createHash("sha256").update(parts.join("|"), "utf8").digest("hex");
}

export function hashJobDescription(description: string): string {
  return createHash("sha256")
    .update(normalizeWhitespace(description), "utf8")
    .digest("hex");
}
