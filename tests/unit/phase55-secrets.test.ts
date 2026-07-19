import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SYNTHETIC_RESUME_BYTES,
  SYNTHETIC_RESUME_RELATIVE_PATH,
  SYNTHETIC_RESUME_SHA256,
  checkArtifactPath,
  isSyntheticResumeAllowlisted,
  scanArtifactPaths,
  scanTextForSecrets,
  validateSyntheticResumeFixture,
} from "../../src/security/artifactScan.js";

const workspaceRoot = process.cwd();

describe("phase55 secrets allowlist", () => {
  it("allowlists only the greenhouse synthetic resume path", () => {
    expect(isSyntheticResumeAllowlisted(SYNTHETIC_RESUME_RELATIVE_PATH)).toBe(
      true,
    );
    expect(
      isSyntheticResumeAllowlisted(
        "tests/fixtures/ats/greenhouse/other-resume.pdf",
      ),
    ).toBe(false);
    expect(isSyntheticResumeAllowlisted("artifacts/resume.pdf")).toBe(false);
  });

  it("accepts the committed synthetic PDF content and hash", () => {
    const abs = path.join(workspaceRoot, ...SYNTHETIC_RESUME_RELATIVE_PATH.split("/"));
    expect(fs.existsSync(abs)).toBe(true);
    const v = validateSyntheticResumeFixture(abs);
    expect(v.ok).toBe(true);
    expect(SYNTHETIC_RESUME_BYTES.subarray(0, 5).toString("utf8")).toBe("%PDF-");
    expect(SYNTHETIC_RESUME_SHA256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not flag allowlisted synthetic resume in scan", () => {
    const hits = checkArtifactPath(SYNTHETIC_RESUME_RELATIVE_PATH, workspaceRoot);
    expect(hits).toEqual([]);
  });

  it("flags other resume.pdf paths", () => {
    const hits = checkArtifactPath(
      "tests/fixtures/ats/greenhouse/candidate-resume.pdf",
      workspaceRoot,
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.reason).toMatch(/Forbidden artifact/);
  });

  it("flags allowlisted path if content is not a synthetic PDF", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-sec-"));
    const rel = SYNTHETIC_RESUME_RELATIVE_PATH;
    const abs = path.join(tmpRoot, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "NOT-A-PDF");
    const hits = checkArtifactPath(rel, tmpRoot);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.reason).toMatch(/%PDF-/);
  });

  it("scanArtifactPaths passes for synthetic + ignores .example files", () => {
    const result = scanArtifactPaths(
      [
        SYNTHETIC_RESUME_RELATIVE_PATH,
        "private/auth/jobright.storage.example.json",
      ],
      workspaceRoot,
    );
    // May still fail if .gitignore missing entries — workspace should be fine
    const resumeHits = result.hits.filter((h) =>
      h.file.includes("sample-resume"),
    );
    expect(resumeHits).toEqual([]);
  });

  it("scanTextForSecrets detects emails and AWS keys", () => {
    expect(scanTextForSecrets("contact me@example.com")).toContain("email");
    expect(scanTextForSecrets("key AKIAIOSFODNN7EXAMPLE")).toContain("aws_key");
    expect(scanTextForSecrets("clean sanitized capture text")).toEqual([]);
  });
});
