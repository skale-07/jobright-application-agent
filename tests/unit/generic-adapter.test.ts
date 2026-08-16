import { describe, expect, it } from "vitest";
import {
  isSameEmployerOrigin,
  isLoopbackUrl,
  validateGenericApplicationUrl,
} from "../../src/ats/generic/urlValidation.js";
import { genericSelectorsV1 } from "../../src/ats/generic/selectors.js";
import {
  classifyGenericSubmission,
  fieldFingerprint,
  fingerprintOverlap,
} from "../../src/ats/generic/submission.js";
import { GenericAdapterV1 } from "../../src/ats/generic/v1.js";
import { detectAtsFromUrl } from "../../src/ats/shared/urlValidationDispatch.js";
import { ATS_BINDINGS } from "../../src/applications/atsBindings.js";
import { resetConfigCache } from "../../src/config/index.js";
import {
  applyControlledFillEnv,
  applySafeFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";

/**
 * Generic (company-hosted) adapter. Most employers do not use one of the
 * five hosted ATS products — in the live corpus 10 of 41 resolved URLs had
 * no supported ATS and every one was a DIFFERENT host, so the tail never
 * converges by adding vendors.
 */
const FORM_HTML = `<!DOCTYPE html><html><body>
  <form>
    <label for="fn">First name</label><input id="fn" name="first_name" />
    <label for="em">Email</label><input id="em" name="email" type="email" />
    <input type="file" name="resume" />
    <button type="submit">Submit application</button>
  </form>
</body></html>`;

const CONFIRMED_HTML = `<!DOCTYPE html><html><body>
  <h1>Application submitted</h1>
  <p>Thank you for applying. Reference id: AB12-9931</p>
</body></html>`;

describe("generic ATS URL validation (UNIT_CONFIRMED)", () => {
  it("accepts any https employer URL — provenance is the trust decision", () => {
    for (const url of [
      "https://www.tesla.com/careers/search/job/apply/279763",
      "https://careers.ibm.com/en_US/careers/JobDetail?jobId=128497",
      "https://jobs.gusto.com/postings/gesture-us-inc-swe/applicants/new",
      "https://careers.smallco.io/apply",
    ]) {
      expect(validateGenericApplicationUrl(url).passed).toBe(true);
    }
  });

  it("names loopback hosts (UNIT_CONFIRMED)", () => {
    expect(isLoopbackUrl("http://localhost:4599/gauntlet")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.1:4599/gauntlet")).toBe(true);
    expect(isLoopbackUrl("https://jobs.lever.co/acme/apply")).toBe(false);
  });

  it("still refuses the two things provenance cannot supply", () => {
    expect(validateGenericApplicationUrl("http://acme.com/apply").failureReason).toMatch(
      /not https/,
    );
    expect(
      validateGenericApplicationUrl("https://jobright.ai/jobs/1").failureReason,
    ).toMatch(/jobright-hosted/);
    expect(validateGenericApplicationUrl("not a url").failureReason).toMatch(
      /unparseable/,
    );
  });

  it("strips tracking params but keeps application identity", () => {
    const v = validateGenericApplicationUrl(
      "https://www.tesla.com/careers/apply?jobId=279763&jr_id=abc&utm_source=x#top",
    );
    expect(v.normalizedUrl).toBe("https://www.tesla.com/careers/apply?jobId=279763");
  });

  it("warns (not refuses) on a bare careers landing page", () => {
    const v = validateGenericApplicationUrl("https://www.tesla.com/");
    expect(v.passed).toBe(true);
    expect(v.warnings.join(" ")).toMatch(/landing page/);
  });

  it("same-employer-origin accepts subdomains, rejects a swapped host", () => {
    expect(
      isSameEmployerOrigin("https://careers.acme.com/apply", "https://www.acme.com/apply/2"),
    ).toBe(true);
    expect(
      isSameEmployerOrigin("https://careers.acme.com/apply", "https://evil.example/apply"),
    ).toBe(false);
  });
});

/**
 * Operator directive 2026-08-14: the generic adapter has no flag of its own.
 * The former GENERIC_ATS_ENABLED gate parked every long-tail employer as
 * UNSUPPORTED_ATS (a live armed run resolved avature/gusto/saashr/
 * techjobsforgood URLs and every one dead-ended), and the console never
 * granted the flag, so armed sessions could not use the adapter at all.
 * Detection/planning are read-only; mutation stays behind the fill flags.
 */
describe("generic ATS dispatch needs no flag (UNIT_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  it("claims a company-hosted URL even in the safe env — and never ahead of a vendor", () => {
    applySafeFillEnv();
    resetConfigCache();
    expect(detectAtsFromUrl("https://www.tesla.com/careers/apply/1").ats).toBe(
      "generic",
    );
    // A supported ATS still wins: generic is asked last.
    expect(
      detectAtsFromUrl("https://boards.greenhouse.io/acme/jobs/123").ats,
    ).toBe("greenhouse");
    // And a MALFORMED vendor URL stays a vendor rejection. Downgrading it
    // to generic would fill a Lever form with structural heuristics while
    // the real adapter sits unused — caught by this test on first run.
    const badLever = detectAtsFromUrl("https://jobs.lever.co/acme/not-a-uuid/apply");
    expect(badLever.ats).toBeNull();
    if (badLever.ats === null) {
      expect(badLever.failureReason).toMatch(/lever\.co is a supported ATS host/);
    }
  });
});

describe("generic submission classification (UNIT_CONFIRMED)", () => {
  it("confirmation text alone is NEVER enough while the form is still there", () => {
    // The fabricated-receipt failure the vendor registries warn about: a
    // live form whose footer says "thank you for applying".
    const stillOnForm = FORM_HTML.replace(
      "</form>",
      "</form><footer>Thank you for applying to Acme</footer>",
    );
    const before = fieldFingerprint(FORM_HTML);
    expect(before.length).toBeGreaterThan(0);
    expect(
      classifyGenericSubmission(stillOnForm, "https://acme.com/apply", {
        preClickFingerprint: before,
      }),
    ).toBe("still_on_form");
  });

  it("confirms when the fields are structurally gone AND the text says so", () => {
    const before = fieldFingerprint(FORM_HTML);
    expect(
      classifyGenericSubmission(CONFIRMED_HTML, "https://acme.com/done", {
        preClickFingerprint: before,
      }),
    ).toBe("confirmed");
  });

  it("a bare thank-you URL never confirms on an unknown host", () => {
    const before = fieldFingerprint(FORM_HTML);
    expect(
      classifyGenericSubmission(
        "<html><body><p>Hello</p></body></html>",
        "https://acme.com/thank-you",
        { preClickFingerprint: before },
      ),
    ).toBe("unknown");
  });

  it("fingerprint overlap measures how much of the form survived", () => {
    const before = fieldFingerprint(FORM_HTML);
    expect(fingerprintOverlap(before, before)).toBe(1);
    expect(fingerprintOverlap(before, [])).toBe(0);
    expect(fingerprintOverlap([], ["anything"])).toBe(0);
  });
});

describe("generic adapter + binding (UNIT_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  it("detects any form with fillable controls, at low confidence", async () => {
    const adapter = new GenericAdapterV1();
    const hit = await adapter.detect({ url: "https://acme.com/apply", html: FORM_HTML });
    expect(hit.matched).toBe(true);
    expect(hit.confidence).toBeLessThan(0.5);
    const miss = await adapter.detect({
      url: "https://acme.com/about",
      html: "<html><body><p>About us</p></body></html>",
    });
    expect(miss.matched).toBe(false);
  });

  it("planApplicationFill plans a company-hosted form in the safe env (read-only)", async () => {
    applySafeFillEnv();
    resetConfigCache();
    const { planApplicationFill } = await import(
      "../../src/applications/applicationFiller.js"
    );
    const { adapter } = await planApplicationFill({
      url: "https://careers.acme.com/apply",
      html: FORM_HTML,
    });
    expect(adapter.id).toBe("generic");
  });

  it("refuses to fill without an approved plan", async () => {
    const adapter = new GenericAdapterV1();
    await expect(
      adapter.fill(null as never, {} as never),
    ).rejects.toThrow(/Approved fill plan required|FORM_FILL_ENABLED/);
  });

  it("reports honestly that it cannot reset an unmodelled form", async () => {
    const r = await new GenericAdapterV1().resetForm(null as never);
    expect(r.reset).toBe(false);
    expect(r.notes.join(" ")).toMatch(/does not reset unknown forms/);
  });

  it("the binding exists, and essays fail closed on a generic host", () => {
    const binding = ATS_BINDINGS.generic;
    expect(binding.id).toBe("generic");
    // Essay execution is Greenhouse-bound; an application carrying essay
    // answers must be refused before submit, not submitted incomplete.
    expect(binding.supportsEssayFill).toBe(false);
    // The healer's locator is vendor-free label similarity + deterministic
    // re-verify — exactly what an unmodelled form needs.
    expect(binding.supportsHealing).toBe(true);
  });

  it("the submit name pattern accepts real phrasings and excludes the traps", () => {
    const { namePattern, excludePattern } = genericSelectorsV1.submitCascade;
    for (const good of ["Submit", "Submit application", "Send application", "Apply now"]) {
      expect(namePattern.test(good)).toBe(true);
    }
    for (const bad of ["Save draft", "Cancel", "Next", "Sign in", "Upload resume", "Withdraw"]) {
      expect(excludePattern.test(bad)).toBe(true);
    }
  });
});
