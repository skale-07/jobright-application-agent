import { describe, expect, it } from "vitest";
import {
  locationTypeaheadQuery,
  locationsMatch,
  shouldComposeCityTypeahead,
} from "../../src/applications/locationQuery.js";
import { buildFillPlan } from "../../src/applications/resolveAnswers.js";
import { parsePublicProfile } from "../../src/candidate/publicProfile.js";
import type { MappedField } from "../../src/applications/fieldNormalization.js";

describe("locationTypeaheadQuery", () => {
  it("expands Baltimore with MD/USA for Places ranking", () => {
    expect(
      locationTypeaheadQuery("Baltimore", "Maryland", "United States"),
    ).toBe("Baltimore, Maryland, USA");
  });
});

describe("shouldComposeCityTypeahead (UNIT_CONFIRMED)", () => {
  it("composes only when city is the lone location field", () => {
    expect(
      shouldComposeCityTypeahead([{ canonical_field: "address.city" }]),
    ).toBe(true);
    expect(
      shouldComposeCityTypeahead([
        { canonical_field: "address.city" },
        { canonical_field: "address.state" },
      ]),
    ).toBe(false);
    expect(
      shouldComposeCityTypeahead([
        { canonical_field: "address.city" },
        { canonical_field: "address.country" },
      ]),
    ).toBe(false);
  });
});

describe("split address city stays the city (UNIT_CONFIRMED)", () => {
  const profile = parsePublicProfile({
    legal_name: { first: "Ada", last: "Lovelace" },
    email: "ada@example.com",
    address: {
      city: "Baltimore",
      state: "Maryland",
      country: "United States",
    },
  });

  function mapped(
    partial: Pick<MappedField, "id" | "label" | "canonical_field">,
  ): MappedField {
    return {
      ...partial,
      type: "text",
      required: false,
      mapping_confidence: "high",
    };
  }

  it("Paylocity-style City + State does not dump the composed string into City", () => {
    const plan = buildFillPlan(
      [
        mapped({
          id: "public-site-address-city",
          label: "City",
          canonical_field: "address.city",
        }),
        mapped({
          id: "public-site-address-us-state",
          label: "State Select a state",
          canonical_field: "address.state",
        }),
      ],
      profile,
    );
    expect(
      plan.entries.find((e) => e.field_id === "public-site-address-city")?.value,
    ).toBe("Baltimore");
  });

  it("a lone Current location field still expands for Places", () => {
    const plan = buildFillPlan(
      [
        mapped({
          id: "location",
          label: "Current location",
          canonical_field: "address.city",
        }),
      ],
      profile,
    );
    expect(plan.entries.find((e) => e.field_id === "location")?.value).toBe(
      "Baltimore, Maryland, USA",
    );
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
