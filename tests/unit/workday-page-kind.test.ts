import { describe, expect, it } from "vitest";
import { classifyWorkdayPage } from "../../src/ats/workday/pageKind.js";

describe("classifyWorkdayPage (UNIT_CONFIRMED)", () => {
  it("Crowe posting: Apply, no password, no My Information", () => {
    expect(
      classifyWorkdayPage(
        `<h1>AI Engineering Intern</h1><button data-automation-id="adventureButton">Apply</button>`,
      ),
    ).toBe("posting");
  });

  it("chooser: Apply Manually, never Autofill", () => {
    expect(
      classifyWorkdayPage(
        `<h2>Start Your Application</h2><button data-automation-id="applyManually">Apply Manually</button>`,
      ),
    ).toBe("chooser");
  });

  it("auth: password field", () => {
    expect(
      classifyWorkdayPage(
        `<input data-automation-id="email" type="email"/><input data-automation-id="password" type="password"/>`,
      ),
    ).toBe("auth");
  });

  /**
   * Live 2026-08-14 (Crowe): Create Account IS step 1 of the wizard and
   * draws the same progress bar as My Information. Classified "wizard",
   * the auth branch never ran, portal auth reported "no sign-in form on
   * this page", and the app parked with credentials unused in the env.
   */
  it("Create Account inside the wizard chrome is auth, not wizard", () => {
    expect(
      classifyWorkdayPage(
        `<div data-automation-id="progressBar">Create Account/Sign In · My Information · Review</div>
         <h2>Create Account</h2>
         <input data-automation-id="email" type="email"/>
         <input data-automation-id="password" type="password"/>
         <input data-automation-id="verifyPassword" type="password"/>`,
      ),
    ).toBe("auth");
  });

  it("wizard: My Information first-name hook", () => {
    expect(
      classifyWorkdayPage(
        `<input data-automation-id="legalNameSection_firstName" name="firstName"/>`,
      ),
    ).toBe("wizard");
  });
});
