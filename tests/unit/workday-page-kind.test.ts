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

  it("wizard: My Information first-name hook", () => {
    expect(
      classifyWorkdayPage(
        `<input data-automation-id="legalNameSection_firstName" name="firstName"/>`,
      ),
    ).toBe("wizard");
  });
});
