import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkableAdapterV1 } from "../../src/ats/workable/v1.js";
import {
  isTrustedWorkableHost,
  validateWorkableApplicationUrl,
} from "../../src/ats/workable/urlValidation.js";
import {
  detectSubmissionUncertainty,
  extractApplicationIdentifier,
} from "../../src/ats/workable/submission.js";
import { detectAtsFromUrl } from "../../src/ats/shared/urlValidationDispatch.js";
import { detectAts } from "../../src/ats/registry.js";
import { ATS_BINDINGS } from "../../src/applications/atsBindings.js";
import { extractOrgSlug } from "../../src/navigation/congruence.js";
import { mapDiscoveredFields } from "../../src/applications/fieldNormalization.js";
import { buildFillPlan } from "../../src/applications/resolveAnswers.js";
import { toApprovedFillPlan } from "../../src/applications/approvedFillPlan.js";
import { parsePublicProfile } from "../../src/candidate/publicProfile.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import {
  applyFixtureFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";

vi.mock("../../src/candidate/sensitiveProfileIO.js", () => ({
  tryLoadSensitiveProfile: () => null,
  getSensitiveValue: () => undefined,
  loadSensitiveProfile: () => {
    throw new Error("loadSensitiveProfile not available in workable tests");
  },
}));

/**
 * Tier-1 exemplar adapter (Workable). Synthetic fixture only — selectors
 * are UNVERIFIED_SELECTOR until a live capture; everything here is
 * UNIT_CONFIRMED / FIXTURE_CONFIRMED at most.
 */

const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures", "ats");
const fixtureHtml = fs.readFileSync(
  path.join(FIXTURE_DIR, "workable", "dom.sanitized.html"),
  "utf8",
);
const FIXTURE_URL = "https://apply.workable.com/acme/j/AB12CD34EF/apply/";

describe("workable URL validation (UNIT_CONFIRMED)", () => {
  it("accepts and normalizes the canonical apply URL", () => {
    const r = validateWorkableApplicationUrl(
      "https://apply.workable.com/acme/j/ab12cd34ef",
    );
    expect(r.passed).toBe(true);
    expect(r.normalizedUrl).toBe(
      "https://apply.workable.com/acme/j/AB12CD34EF/apply/",
    );
    expect(r.company).toBe("acme");
    expect(r.shortcode).toBe("AB12CD34EF");
    expect(r.warnings.join(" ")).toMatch(/normalized to the form URL/);
  });

  it("normalizes legacy company-subdomain URLs to apply.workable.com", () => {
    const r = validateWorkableApplicationUrl(
      "https://acme.workable.com/j/AB12CD34EF",
    );
    expect(r.passed).toBe(true);
    expect(r.normalizedUrl).toBe(
      "https://apply.workable.com/acme/j/AB12CD34EF/apply/",
    );
    expect(r.warnings.join(" ")).toMatch(/Legacy company-subdomain/);
  });

  it("rejection battery: scheme, credentials, port, host, path", () => {
    const bad = [
      "http://apply.workable.com/acme/j/AB12CD34EF",
      "https://user:pw@apply.workable.com/acme/j/AB12CD34EF",
      "https://apply.workable.com:8443/acme/j/AB12CD34EF",
      "https://evil.example.com/acme/j/AB12CD34EF",
      "https://www.workable.com/j/AB12CD34EF",
      "https://jobs.workable.com/j/AB12CD34EF",
      "https://apply.workable.com/acme",
      "https://apply.workable.com/",
      "javascript:alert(1)",
    ];
    for (const url of bad) {
      expect(validateWorkableApplicationUrl(url).passed, url).toBe(false);
    }
  });

  it("trusted-host check mirrors the validator's host rules", () => {
    expect(isTrustedWorkableHost("https://apply.workable.com/x/j/ABCDEF12")).toBe(true);
    expect(isTrustedWorkableHost("https://acme.workable.com/j/ABCDEF12")).toBe(true);
    expect(isTrustedWorkableHost("https://www.workable.com/")).toBe(false);
    expect(isTrustedWorkableHost("https://workable.evil.com/")).toBe(false);
  });

  it("the multi-ATS dispatcher claims workable URLs", () => {
    const d = detectAtsFromUrl("https://apply.workable.com/acme/j/AB12CD34EF/apply/");
    expect(d.ats).toBe("workable");
    if (d.ats === "workable") {
      expect(d.normalizedUrl).toBe(FIXTURE_URL);
    }
    // A lookalike host never gets the WORKABLE adapter (it falls to the
    // generic long-tail path instead — validation and congruence still run).
    expect(
      detectAtsFromUrl("https://apply.workable.com.evil.com/a/j/B1C2D3E4").ats,
    ).not.toBe("workable");
  });

  it("workable binding is registered with the generic gate", () => {
    expect(ATS_BINDINGS.workable.id).toBe("workable");
    expect(ATS_BINDINGS.workable.supportsEssayFill).toBe(false);
  });

  it("congruence decodes the org slug from both URL shapes", () => {
    expect(extractOrgSlug("https://apply.workable.com/acme/j/AB12CD34EF/apply/")).toBe("acme");
    expect(extractOrgSlug("https://acme.workable.com/j/AB12CD34EF")).toBe("acme");
    expect(extractOrgSlug("https://www.workable.com/anything")).toBeNull();
  });
});

describe("workable detection + discovery (FIXTURE_CONFIRMED, synthetic)", () => {
  it("detects the fixture page and wins registry dispatch", async () => {
    const adapter = new WorkableAdapterV1();
    const d = await adapter.detect({ url: FIXTURE_URL, html: fixtureHtml });
    expect(d.matched).toBe(true);
    expect(d.confidence).toBeGreaterThanOrEqual(0.5);
    const { adapter: dispatched } = await detectAts({
      url: FIXTURE_URL,
      html: fixtureHtml,
    });
    expect(dispatched.id).toBe("workable");
  });

  it("discovers separate first/last name fields, resume, and the custom select", async () => {
    const adapter = new WorkableAdapterV1();
    const fields = await adapter.discoverFields({ html: fixtureHtml });
    const byName = new Map(fields.map((f) => [f.name, f]));
    expect(byName.has("firstname")).toBe(true);
    expect(byName.has("lastname")).toBe(true);
    expect(byName.get("resume")?.type).toBe("file");
    const workauth = fields.find((f) => /legally authorized/i.test(f.label));
    expect(workauth?.type).toBe("select");
    expect(workauth?.options).toContain("Yes");
  });
});

describe("workable submission classification (UNIT_CONFIRMED)", () => {
  const FORM = `<form data-ui="application-form"><button data-ui="submit-application">Submit application</button></form>`;

  it("confirmation copy with the form GONE confirms", () => {
    expect(
      detectSubmissionUncertainty(
        "<html><body>Thank you for applying to Acme.</body></html>",
        "https://apply.workable.com/acme/j/AB12CD34EF/apply/",
      ),
    ).toBe("confirmed");
  });

  it("confirmation-like copy with the form still present is still_on_form", () => {
    expect(
      detectSubmissionUncertainty(
        `<html><body>Thank you for your interest.${FORM}</body></html>`,
        "https://apply.workable.com/acme/j/AB12CD34EF/apply/",
      ),
    ).toBe("still_on_form");
  });

  it("thank-you URL confirms; error body at that URL does not", () => {
    expect(
      detectSubmissionUncertainty(
        "<html><body>anything</body></html>",
        "https://apply.workable.com/acme/j/AB12CD34EF/thank-you/",
      ),
    ).toBe("confirmed");
    expect(
      detectSubmissionUncertainty(
        "<html><body><h1>500 Internal Server Error</h1></body></html>",
        "https://apply.workable.com/acme/j/AB12CD34EF/thank-you/",
      ),
    ).toBe("error_page");
  });

  it("extracts an application identifier when present", () => {
    expect(
      extractApplicationIdentifier("Your application ID: WRK-12345 has been received"),
    ).toBe("WRK-12345");
    expect(extractApplicationIdentifier("no id here")).toBeNull();
  });
});

describe("workable fill round-trip (FIXTURE_CONFIRMED, synthetic)", () => {
  useIsolatedFillEnv("fixture_fill");

  const TEST_ALIASES: Record<string, string[]> = {
    "legal_name.first": ["First name"],
    "legal_name.last": ["Last name"],
    email: ["Email"],
    phone: ["Phone"],
    linkedin_url: ["LinkedIn URL"],
    work_authorization: ["Are you legally authorized to work"],
  };

  const PROFILE = parsePublicProfile({
    legal_name: { first: "Ada", last: "Lovelace" },
    email: "ada@example.com",
    phone: "555-0100",
    linkedin_url: "https://linkedin.com/in/ada-example",
    work_authorization: "Yes",
  });

  it(
    "fills first/last/email/phone from the approved plan and verifies",
    async () => {
      applyFixtureFillEnv();
      const adapter = new WorkableAdapterV1();
      const fields = await adapter.discoverFields({ html: fixtureHtml });
      const mapped = mapDiscoveredFields(fields, TEST_ALIASES);
      const plan = buildFillPlan(mapped, PROFILE);
      const approved = toApprovedFillPlan(plan.entries);
      adapter.setFillContext(plan.entries, fields);
      adapter.setApprovedFillPlan(approved);

      await withFixtureHtmlPage(fixtureHtml, async (page) => {
        const fill = await adapter.fill(page, {});
        expect(fill.errors).toEqual([]);
        expect(fill.filled.length).toBeGreaterThanOrEqual(4);
        expect(await page.inputValue("#firstname")).toBe("Ada");
        expect(await page.inputValue("#lastname")).toBe("Lovelace");
        expect(await page.inputValue("#email")).toBe("ada@example.com");
        // Cover-letter textarea is essay-territory — never auto-filled.
        expect(await page.inputValue("#qa-coverletter")).toBe("");

        const verify = await adapter.verify(page, {
          "legal_name.first": "Ada",
          "legal_name.last": "Lovelace",
          email: "ada@example.com",
          phone: "555-0100",
          linkedin_url: "https://linkedin.com/in/ada-example",
          work_authorization: "Yes",
        });
        expect(verify.fields.length).toBeGreaterThanOrEqual(4);
        expect(verify.passed).toBe(true);
      });
    },
    45_000,
  );
});
