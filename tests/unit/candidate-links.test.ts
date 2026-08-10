import { describe, expect, it } from "vitest";
import {
  explainAtsAnchorMisses,
  selectCandidateApplyLinks,
  traversalHosts,
} from "../../src/navigation/candidateLinks.js";

/**
 * Candidate-link selection for the nav agent goal — from the first
 * hands-off run: the winning agent navigated DIRECTLY to a URL; the six
 * losers scrolled jobright while the answer sat in phase A's ignored
 * hrefs (greenhouse board links, Workday tenants, career sites).
 * UNIT_CONFIRMED.
 */
describe("candidate apply links (UNIT_CONFIRMED)", () => {
  const RUN_HREFS = [
    "https://x.com/cadence",
    "https://www.linkedin.com/company/cadence",
    "https://www.crunchbase.com/organization/cadence",
    "https://www.glassdoor.com/cadence",
    "https://cadence.wd1.myworkdayjobs.com/External_Careers",
    "https://www.cadence.com/en_US/home/company/careers.html",
  ];

  it("prefers ATS-ish hosts, drops socials, one per host", () => {
    const links = selectCandidateApplyLinks(RUN_HREFS);
    expect(links[0]).toBe("https://cadence.wd1.myworkdayjobs.com/External_Careers");
    expect(links).toContain(
      "https://www.cadence.com/en_US/home/company/careers.html",
    );
    expect(links.join(" ")).not.toMatch(/x\.com|linkedin|crunchbase|glassdoor/);
  });

  it("greenhouse BOARD links (invalid as application URLs) still lead", () => {
    const links = selectCandidateApplyLinks([
      "https://www.glassdoor.com/acme",
      "https://boards.greenhouse.io/acme",
    ]);
    expect(links).toEqual(["https://boards.greenhouse.io/acme"]);
  });

  it("caps the list and survives malformed hrefs", () => {
    const many = Array.from({ length: 10 }, (_, i) => `https://site${i}.example.com/jobs`);
    expect(selectCandidateApplyLinks(["not a url", ...many]).length).toBe(4);
  });

  // Session 4a7c199b: Figma's job page held a boards.greenhouse.io anchor,
  // yet the app died as a bare budget wall — the report named the host but
  // not WHY validation rejected it, so the miss was undiagnosable.
  it("explains WHY a supported-ATS-host anchor failed strict validation", () => {
    const notes = explainAtsAnchorMisses([
      "https://boards.greenhouse.io/figma", // board root — not a job URL
      "https://www.figma.com/careers", // not an ATS family host — silent
    ]);
    expect(notes.length).toBe(1);
    expect(notes[0]).toMatch(/greenhouse-host anchor failed strict validation/);
    expect(notes[0]).toMatch(/boards\.greenhouse\.io\/figma/);
    expect(notes[0]).toMatch(/not a recognizable Greenhouse job application path/i);
  });

  it("says nothing about anchors that VALIDATE (phase A takes those)", () => {
    expect(
      explainAtsAnchorMisses(["https://boards.greenhouse.io/figma/jobs/123"]),
    ).toEqual([]);
  });

  it("never echoes query strings, dedupes by host+path, and caps output", () => {
    const notes = explainAtsAnchorMisses([
      "https://jobs.lever.co/acme?token=SUPERSECRET",
      "https://jobs.lever.co/acme?token=OTHERSECRET", // same host+path → one note
      "https://jobs.ashbyhq.com/", // root fails too
      "https://apply.workable.com/", // root fails too
      "https://boards.greenhouse.io/x/jobs/notnumeric/extra", // would be 4th
    ]);
    expect(notes.length).toBe(3); // default cap
    expect(notes.join(" ")).not.toMatch(/SUPERSECRET|OTHERSECRET/);
    expect(notes[0]).toMatch(/lever-host anchor/);
  });

  it("traversalHosts filters socials and dedupes", () => {
    const hosts = traversalHosts(RUN_HREFS);
    expect(hosts).toContain("cadence.wd1.myworkdayjobs.com");
    expect(hosts).toContain("www.cadence.com");
    expect(hosts.join(" ")).not.toMatch(/x\.com|linkedin/);
  });
});
