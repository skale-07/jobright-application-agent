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
});
