import { describe, expect, it } from "vitest";
import { hostInAllowedDomains } from "../../src/agent/navigate.js";

/**
 * Allowed-domains matching for the nav agent's final URL.
 *
 * Live regression (2026-08-11): the allowlist carried
 * `boards.greenhouse.io`, the agent landed on `job-boards.greenhouse.io` —
 * the same Greenhouse product under a sibling hostname — and the whole
 * turn was discarded as an allowed-domains violation. Family matching
 * fixes that WITHOUT becoming a general "same registrable domain" rule,
 * which would let one employer's URL be accepted for another's job.
 */
describe("agent allowed-domains matching (UNIT_CONFIRMED)", () => {
  it("accepts the exact host and its subdomains", () => {
    expect(hostInAllowedDomains("jobs.lever.co", ["jobs.lever.co"])).toBe(true);
    expect(
      hostInAllowedDomains("careers.acme.com", ["acme.com"]),
    ).toBe(true);
  });

  it("accepts a sibling hostname within a known ATS family", () => {
    // The live case.
    expect(
      hostInAllowedDomains("job-boards.greenhouse.io", ["boards.greenhouse.io"]),
    ).toBe(true);
    expect(
      hostInAllowedDomains("jobs.eu.lever.co", ["jobs.lever.co"]),
    ).toBe(true);
    expect(
      hostInAllowedDomains("acme.wd5.myworkdayjobs.com", [
        "cadence.wd1.myworkdayjobs.com",
      ]),
    ).toBe(true);
  });

  it("does NOT treat two employers as siblings just because the domain matches", () => {
    // The dangerous generalisation: registrable-domain matching outside
    // the ATS list would accept another company's careers host.
    expect(hostInAllowedDomains("careers.evil.com", ["shop.acme.com"])).toBe(false);
    expect(hostInAllowedDomains("jobs.other.com", ["www.other-co.com"])).toBe(false);
  });

  it("rejects a host with no relationship to the allowlist", () => {
    expect(hostInAllowedDomains("www.ycombinator.com", ["jobs.lever.co"])).toBe(
      false,
    );
  });

  /**
   * Deliberate reversal (operator directive 2026-08-14: "the system weighs
   * the host name far too much"). A supported ATS host is an acceptable
   * landing place even when the JobRight page linked no vendor at all —
   * the old rule threw away agent turns that had reached a real
   * application form. Acceptance is still decided downstream by the
   * adapter's URL validation and the congruence check, which is what
   * catches another employer's board.
   */
  it("a supported ATS host is allowed even with an empty allowlist", () => {
    expect(hostInAllowedDomains("jobs.lever.co", [])).toBe(true);
    expect(hostInAllowedDomains("boards.greenhouse.io", [])).toBe(true);
    // Still not a free pass for anything that is not a known ATS.
    expect(hostInAllowedDomains("careers.randomcorp.com", [])).toBe(false);
  });

  it("is case-insensitive on both sides", () => {
    expect(
      hostInAllowedDomains("JOB-BOARDS.Greenhouse.IO", ["Boards.Greenhouse.io"]),
    ).toBe(true);
  });
});
