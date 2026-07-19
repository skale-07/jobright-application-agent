import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Only this synthetic Greenhouse upload fixture may match resume.pdf patterns. */
export const SYNTHETIC_RESUME_RELATIVE_PATH =
  "tests/fixtures/ats/greenhouse/sample-resume.pdf";

/** Exact bytes of the committed minimal PDF (LF newlines). */
export const SYNTHETIC_RESUME_BYTES = Buffer.from(
  "%PDF-1.1\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n",
  "utf8",
);

export const SYNTHETIC_RESUME_SHA256 = createHash("sha256")
  .update(SYNTHETIC_RESUME_BYTES)
  .digest("hex");

export const FORBIDDEN_ARTIFACT_NAME_PATTERNS: RegExp[] = [
  /\.storage\.json$/i,
  /sensitive-profile\.json$/i,
  /sensitive-profile\.draft\.json$/i,
  /sensitive-profile\.enc$/i,
  /master\.key\.dpapi$/i,
  /cookies\.json$/i,
  /resume\.pdf$/i,
  /cover-letter\.pdf$/i,
  /submission-receipt\.json$/i,
];

export const REQUIRED_GITIGNORE_ENTRIES = [
  "private/",
  "data/",
  "artifacts/",
  "*.storage.json",
  "*.enc",
] as const;

export type ArtifactScanHit = {
  file: string;
  reason: string;
};

export type ArtifactScanResult = {
  ok: boolean;
  hits: ArtifactScanHit[];
};

function normalizeRel(p: string): string {
  return p.replace(/\\/g, "/");
}

export function isSyntheticResumeAllowlisted(relativePath: string): boolean {
  return normalizeRel(relativePath) === SYNTHETIC_RESUME_RELATIVE_PATH;
}

/**
 * Validate allowlisted synthetic resume: path allowlist + %PDF- prefix + optional hash.
 */
export function validateSyntheticResumeFixture(
  absolutePath: string,
  opts: { requireExactHash?: boolean } = {},
): { ok: boolean; reason?: string } {
  if (!fs.existsSync(absolutePath)) {
    return { ok: false, reason: "Synthetic resume fixture missing" };
  }
  const buf = fs.readFileSync(absolutePath);
  if (buf.subarray(0, 5).toString("utf8") !== "%PDF-") {
    return { ok: false, reason: "Synthetic resume must start with %PDF-" };
  }
  if (opts.requireExactHash !== false) {
    const sha = createHash("sha256").update(buf).digest("hex");
    if (sha !== SYNTHETIC_RESUME_SHA256) {
      return {
        ok: false,
        reason: `Synthetic resume sha256 mismatch (got ${sha}, expected ${SYNTHETIC_RESUME_SHA256})`,
      };
    }
  }
  return { ok: true };
}

/**
 * Check a single relative workspace path against forbidden artifact patterns.
 * Allowlists only the synthetic Greenhouse sample-resume.pdf (with content checks).
 */
export function checkArtifactPath(
  relativePath: string,
  workspaceRoot: string,
): ArtifactScanHit[] {
  const hits: ArtifactScanHit[] = [];
  const norm = normalizeRel(relativePath);
  const base = path.basename(norm);

  if (norm.startsWith("private/") && !norm.includes(".example.")) {
    hits.push({
      file: norm,
      reason: "Sensitive path should not be tracked",
    });
  }

  if (norm.includes(".example.")) {
    return hits;
  }

  for (const re of FORBIDDEN_ARTIFACT_NAME_PATTERNS) {
    if (!re.test(base) && !re.test(norm)) continue;

    if (isSyntheticResumeAllowlisted(norm) && /resume\.pdf$/i.test(base)) {
      const abs = path.join(workspaceRoot, ...norm.split("/"));
      const v = validateSyntheticResumeFixture(abs);
      if (!v.ok) {
        hits.push({
          file: norm,
          reason: v.reason ?? "Synthetic resume allowlist validation failed",
        });
      }
      continue;
    }

    hits.push({
      file: norm,
      reason: `Forbidden artifact pattern matched: ${re}`,
    });
  }

  return hits;
}

export function checkGitignoreContents(gitignoreText: string): ArtifactScanHit[] {
  const hits: ArtifactScanHit[] = [];
  for (const required of REQUIRED_GITIGNORE_ENTRIES) {
    if (!gitignoreText.includes(required)) {
      hits.push({
        file: ".gitignore",
        reason: `.gitignore missing required entry: ${required}`,
      });
    }
  }
  return hits;
}

/**
 * Scan a list of relative paths (e.g. git ls-files) for forbidden artifacts.
 */
export function scanArtifactPaths(
  relativePaths: string[],
  workspaceRoot: string,
): ArtifactScanResult {
  const hits: ArtifactScanHit[] = [];
  for (const file of relativePaths) {
    hits.push(...checkArtifactPath(file, workspaceRoot));
  }
  const giPath = path.join(workspaceRoot, ".gitignore");
  if (fs.existsSync(giPath)) {
    hits.push(...checkGitignoreContents(fs.readFileSync(giPath, "utf8")));
  }
  return { ok: hits.length === 0, hits };
}

/** Patterns used to reject promoting captures that still contain secrets/PII. */
export const PROMOTE_SECRET_SCAN_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "email", re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  { name: "phone", re: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/ },
  { name: "bearer", re: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/i },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/ },
  { name: "aws_key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "private_key", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "api_key_assignment", re: /(?:api[_-]?key|secret[_-]?key)\s*[:=]\s*['"]?[^\s"'<>]{8,}/i },
  { name: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/ },
];

export function scanTextForSecrets(text: string): string[] {
  const found: string[] = [];
  for (const { name, re } of PROMOTE_SECRET_SCAN_PATTERNS) {
    if (re.test(text)) found.push(name);
  }
  return found;
}
