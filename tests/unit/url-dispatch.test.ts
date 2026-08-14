import { describe, expect, it } from "vitest";
import { detectAtsFromUrl } from "../../src/ats/shared/urlValidationDispatch.js";

describe("detectAtsFromUrl (W3, UNIT_CONFIRMED)", () => {
  const cases: Array<[string, string | null]> = [
    ["https://boards.greenhouse.io/acme/jobs/4012345", "greenhouse"],
    ["https://job-boards.greenhouse.io/acme/jobs/4012345", "greenhouse"],
    [
      "https://jobs.lever.co/acme/a1b2c3d4-e5f6-7890-abcd-ef1234567890/apply",
      "lever",
    ],
    [
      "https://jobs.eu.lever.co/acme/a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "lever",
    ],
    [
      "https://jobs.ashbyhq.com/acme/9b1e0c2a-1234-4abc-8def-1234567890ab/application",
      "ashby",
    ],
    ["https://jobs.ashbyhq.com/acme/9b1e0c2a-1234-4abc-8def-1234567890ab", "ashby"],
    ["https://acme.wd1.myworkdayjobs.com/en-US/careers/job/x", null],
    ["http://jobs.lever.co/acme/a1b2c3d4-e5f6-7890-abcd-ef1234567890", null],
    // Company-hosted long tail: generic claims it (no flag — operator
    // directive 2026-08-14).
    ["https://careers.example.com/apply/123", "generic"],
    ["javascript:alert(1)", null],
  ];

  for (const [url, expected] of cases) {
    it(`classifies ${url} → ${expected ?? "unsupported"}`, () => {
      const d = detectAtsFromUrl(url);
      expect(d.ats).toBe(expected);
      if (d.ats === null) {
        expect(d.failureReason).toMatch(/greenhouse: .*lever: .*ashby: /s);
      } else {
        expect(d.normalizedUrl).toMatch(/^https:\/\//);
      }
    });
  }

  it("normalizes lever posting URLs to /apply and ashby to /application", () => {
    const lever = detectAtsFromUrl(
      "https://jobs.lever.co/acme/a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    );
    expect(lever.ats === "lever" && lever.normalizedUrl.endsWith("/apply")).toBe(
      true,
    );
    const ashby = detectAtsFromUrl(
      "https://jobs.ashbyhq.com/acme/9b1e0c2a-1234-4abc-8def-1234567890ab",
    );
    expect(
      ashby.ats === "ashby" && ashby.normalizedUrl.endsWith("/application"),
    ).toBe(true);
  });

  it("preserves greenhouse normalization exactly", () => {
    const d = detectAtsFromUrl(
      "https://boards.greenhouse.io/acme/jobs/4012345?utm_source=x",
    );
    expect(d.ats).toBe("greenhouse");
    expect(d.ats === "greenhouse" && d.normalizedUrl).toBe(
      "https://boards.greenhouse.io/acme/jobs/4012345",
    );
  });
});
