import { describe, expect, it } from "vitest";
import { matchCanonicalField } from "../../src/applications/fieldNormalization.js";

describe("matchCanonicalField name/id fallbacks", () => {
  it("maps Lever location-input and org without relying on alias phrase alone", () => {
    expect(
      matchCanonicalField(
        { id: "location-input", label: "location", type: "text", required: false, name: "location" },
        {},
      ),
    ).toBe("address.city");
    expect(
      matchCanonicalField(
        { id: "org", label: "org", type: "text", required: false, name: "org" },
        {},
      ),
    ).toBe("current_company");
  });

  it("maps eeo[race]/eeo[veteran] ids to sensitive canonicals", () => {
    expect(
      matchCanonicalField(
        { id: "eeo[race]", label: "eeo[race]", type: "select", required: false, name: "eeo[race]" },
        {},
      ),
    ).toBe("race_ethnicity");
    expect(
      matchCanonicalField(
        { id: "eeo[veteran]", label: "eeo[veteran]", type: "select", required: false, name: "eeo[veteran]" },
        {},
      ),
    ).toBe("veteran_status");
  });
});
