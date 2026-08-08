import { describe, expect, it } from "vitest";
import {
  locationTypeaheadQuery,
  locationsMatch,
} from "../../src/applications/locationQuery.js";

describe("locationTypeaheadQuery", () => {
  it("expands Baltimore with MD/USA for Places ranking", () => {
    expect(
      locationTypeaheadQuery("Baltimore", "Maryland", "United States"),
    ).toBe("Baltimore, Maryland, USA");
  });
});

describe("locationsMatch", () => {
  it("accepts Places commit vs bare city or expanded plan value", () => {
    expect(locationsMatch("Baltimore", "Baltimore, MD, USA")).toBe(true);
    expect(
      locationsMatch("Baltimore, Maryland, USA", "Baltimore, MD, United States"),
    ).toBe(true);
  });

  it("never matches on short or partial first tokens (verify-gate safety)", () => {
    // The first token must be a whole word of >=4 chars — otherwise phrases
    // starting with "I", "No", "New" would match nearly anything and quietly
    // pass the pre-click verify gate.
    expect(locationsMatch("I am not a veteran", "I identify as a veteran")).toBe(
      false,
    );
    expect(locationsMatch("No", "I do not want to answer")).toBe(false);
    expect(
      locationsMatch("New York, New York, USA", "New Jersey, USA"),
    ).toBe(false);
    // Multi-word city segments still match across expansions.
    expect(locationsMatch("New York, NY", "New York, New York, USA")).toBe(true);
    // Whole-word: "Balt" is not a match for "Baltimore".
    expect(locationsMatch("Balt, MD", "Baltimore, MD, USA")).toBe(false);
  });
});
