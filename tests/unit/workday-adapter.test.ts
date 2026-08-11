import { describe, expect, it } from "vitest";
import {
  validateWorkdayApplicationUrl,
  isTrustedWorkdayHost,
} from "../../src/ats/workday/urlValidation.js";
import { detectAtsFromUrl } from "../../src/ats/shared/urlValidationDispatch.js";
import { extractOrgSlug } from "../../src/navigation/congruence.js";
import { isRecognizedAtsAuthHost } from "../../src/verification/portalAuth.js";

/**
 * Workday W1: recognize the multi-tenant URL shape that phases A/B kept
 * ignoring (interdigital.wd5 / medtronic.wd1 anchors). URL validation is
 * pure — UNIT_CONFIRMED.
 */
describe("workday URL validation (UNIT_CONFIRMED)", () => {
  it("accepts the canonical tenant job path and normalizes off apply suffixes", () => {
    const v = validateWorkdayApplicationUrl(
      "https://interdigital.wd5.myworkdayjobs.com/en-US/Careers/job/Conshohocken-PA/Generative-AI-Intern_R-2025-1234/apply/applyManually",
    );
    expect(v.passed).toBe(true);
    expect(v.tenant).toBe("interdigital");
    expect(v.requisitionId).toBe("R-2025-1234");
    expect(v.normalizedUrl).toBe(
      "https://interdigital.wd5.myworkdayjobs.com/en-US/Careers/job/Conshohocken-PA/Generative-AI-Intern_R-2025-1234",
    );
  });

  it("accepts a details deep link and a locale-less path", () => {
    expect(
      validateWorkdayApplicationUrl(
        "https://medtronic.wd1.myworkdayjobs.com/Medtronic/details/Engineer_JR0031966",
      ).passed,
    ).toBe(true);
    const noLocale = validateWorkdayApplicationUrl(
      "https://acme.wd12.myworkdayjobs.com/Careers/job/Intern_25-9",
    );
    expect(noLocale.passed).toBe(true);
    expect(noLocale.requisitionId).toBe("25-9");
  });

  it("rejection battery: scheme, host, port, tenant root, slug without req", () => {
    for (const bad of [
      "http://acme.wd5.myworkdayjobs.com/Careers/job/Intern_R-1",
      "https://acme.workday.com/careers", // marketing host, not a tenant job board
      "https://acme.wd5.myworkdayjobs.com:8443/Careers/job/Intern_R-1",
      "https://acme.wd5.myworkdayjobs.com/",
      "https://acme.wd5.myworkdayjobs.com/Careers/job/JustATitleNoReq",
      "https://boards.greenhouse.io/acme/jobs/123",
      "javascript:alert(1)",
    ]) {
      expect(validateWorkdayApplicationUrl(bad).passed, bad).toBe(false);
    }
  });

  it("the shared dispatcher claims Workday URLs", () => {
    const d = detectAtsFromUrl(
      "https://interdigital.wd5.myworkdayjobs.com/en-US/Careers/job/Intern_R-2025-1234",
    );
    expect(d.ats).toBe("workday");
  });

  it("congruence extracts the tenant as the employer slug", () => {
    expect(
      extractOrgSlug(
        "https://interdigital.wd5.myworkdayjobs.com/en-US/Careers/job/Intern_R-1",
      ),
    ).toBe("interdigital");
  });

  it("host trust + recognized auth host gate cover every tenant, nothing else", () => {
    expect(isTrustedWorkdayHost("https://x.wd103.myworkdayjobs.com/a/job/b_R1")).toBe(true);
    expect(isTrustedWorkdayHost("https://evil.example.com/a")).toBe(false);
    expect(isRecognizedAtsAuthHost("https://x.wd5.myworkdayjobs.com/x")).toBe(true);
    // The credential-spray guard: an arbitrary host is NEVER an auth host.
    expect(isRecognizedAtsAuthHost("https://phish.example.com/signin")).toBe(false);
  });
});
