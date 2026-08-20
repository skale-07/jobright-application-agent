import { describe, expect, it } from "vitest";
import { verifyPageBeforeMutationGeneric } from "../../src/ats/shared/preMutationGate.js";
import { classifyWorkdayPage } from "../../src/ats/workday/pageKind.js";
import { workdaySelectorsV1 } from "../../src/ats/workday/selectors.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";

/**
 * A posting page is not an application form.
 *
 * Live 2026-08-14 (Crowe, first Workday fill): navigation resolved the
 * CORRECT, congruent posting URL —
 * crowe.wd12.myworkdayjobs.com/external_careers/job/Chicago-IL-USA/AI-Engineering-Intern_R-51782
 * — and the fill ran against the job DESCRIPTION. The gate passed because
 * Workday stamps data-automation-id on every page, so `formMarkers`
 * matched; the run then reported 0 fillable, 0 filled, verify failed, and
 * a login-wall diagnosis of "no_form_found … submit=[Sign In]". Every
 * symptom pointed at selectors; the cause was that the page had no form.
 *
 * The WALK from posting to form lives in portalAuth (Apply → Apply
 * Manually, never Workday's own resume autofill). What is asserted here is
 * the pair that makes that walk diagnosable: the shared gate refuses a
 * field-less page for every adapter, and classifyWorkdayPage names which
 * Workday page the run is looking at.
 */
describe("posting page vs application form (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  const POSTING_HTML = `<!DOCTYPE html><html><body>
    <div data-automation-id="jobPostingHeader">AI Engineering Intern</div>
    <div data-automation-id="jobPostingDescription">
      <p>Crowe is hiring an AI Engineering Intern in Chicago.</p>
    </div>
    <a data-automation-id="adventureButton" role="button">Apply</a>
    <button>Sign In</button>
  </body></html>`;

  const CHOOSER_HTML = `<!DOCTYPE html><html><body>
    <div data-automation-id="applyFlowModal">
      <h2>Start Your Application</h2>
      <button data-automation-id="autofillWithResume">Autofill with Resume</button>
      <button data-automation-id="applyManually">Apply Manually</button>
    </div>
  </body></html>`;

  const FORM_HTML = `<!DOCTYPE html><html><body>
    <form data-automation-id="applicationForm">
      <label for="fn">First Name</label>
      <input id="fn" data-automation-id="legalNameSection_firstName" name="firstName" />
      <label for="em">Email</label>
      <input id="em" data-automation-id="email" name="email" type="email" />
    </form>
  </body></html>`;

  it("refuses a marker-matching page that has no fillable fields", async () => {
    await withFixtureHtmlPage(POSTING_HTML, async (page) => {
      const gate = await verifyPageBeforeMutationGeneric(page, {
        isTrustedHost: () => true,
        formMarkers: workdaySelectorsV1.formMarkers,
      });
      expect(gate.ok).toBe(false);
      expect(gate.failureCode).toBe("NO_APPLICATION_FORM");
      expect(gate.reason).toMatch(/no fillable fields|posting\/description page/);
    });
  }, 30_000);

  it("refuses the apply-method chooser too — a modal is not a form", async () => {
    await withFixtureHtmlPage(CHOOSER_HTML, async (page) => {
      const gate = await verifyPageBeforeMutationGeneric(page, {
        isTrustedHost: () => true,
        formMarkers: workdaySelectorsV1.formMarkers,
      });
      expect(gate.ok).toBe(false);
      expect(gate.failureCode).toBe("NO_APPLICATION_FORM");
    });
  }, 30_000);

  it("still passes a real application form", async () => {
    await withFixtureHtmlPage(FORM_HTML, async (page) => {
      const gate = await verifyPageBeforeMutationGeneric(page, {
        isTrustedHost: () => true,
        formMarkers: workdaySelectorsV1.formMarkers,
      });
      expect(gate.ok).toBe(true);
      expect(gate.failureCode).toBeNull();
    });
  }, 30_000);

  it("passes a field-bearing page that has no wrapping <form> tag", async () => {
    const html = `<!DOCTYPE html><html><body>
      <label>Country</label>
      <input id="public-site-address-country" />
      <label>City</label>
      <input id="public-site-address-city" />
    </body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const gate = await verifyPageBeforeMutationGeneric(page, {
        isTrustedHost: () => true,
        formMarkers: /<form[\s>]/i,
      });
      expect(gate.ok).toBe(true);
    });
  }, 30_000);

  /**
   * The page kind is what turns a bare refusal into a diagnosis. These are
   * the same three live situations the old URL heuristic tried to infer
   * from the path — read off the page itself instead, so an apply URL that
   * still renders the description is not mistaken for the form.
   */
  describe("the refused page is named, not just refused", () => {
    it("Crowe's posting reads as posting", () => {
      expect(classifyWorkdayPage(POSTING_HTML)).toBe("posting");
    });

    it("the Start Your Application modal reads as chooser", () => {
      expect(classifyWorkdayPage(CHOOSER_HTML)).toBe("chooser");
    });

    it("the My Information wizard reads as wizard — and fills", () => {
      expect(classifyWorkdayPage(FORM_HTML)).toBe("wizard");
    });
  });
});
