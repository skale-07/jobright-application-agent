import { describe, expect, it } from "vitest";
import {
  applyHarvestedOptions,
  findOtherOption,
  harvestFieldOptions,
} from "../../src/ats/shared/optionHarvest.js";
import { pickSpecifyField } from "../../src/ats/shared/otherSpecify.js";
import { discoverFieldsFromHtml } from "../../src/applications/fieldDiscovery.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";
import type { DiscoveredField } from "../../src/ats/adapter.js";

/**
 * Live option harvest (operator directive 2026-08-14: "first scraping the
 * possible outcomes for each field is probably the most efficient
 * solution").
 *
 * The Appian failure this closes: planning is HTML-only, and a React-select
 * keeps its option list out of the HTML until the control is opened. So a
 * dropdown reached the planner with an empty answer space, the planner fell
 * through to free text, and the run typed "Summer Atlantic Capital" into a
 * list whose only honest answer was "Other" — the control showed "No
 * options" and the field stayed blank.
 */
describe("harvestFieldOptions (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  /** A React-select whose options exist only after the control is clicked. */
  const REACT_SELECT = `<!DOCTYPE html><html><body>
    <label for="org">University organizations</label>
    <div class="select__control" id="org-shell">
      <input id="org" name="org" role="combobox" aria-autocomplete="list" />
    </div>
    <div id="menu"></div>
    <script>
      document.getElementById('org-shell').addEventListener('click', () => {
        document.getElementById('menu').innerHTML =
          '<div role="listbox">' +
          '<div role="option">Alpha Kappa Psi</div>' +
          '<div role="option">Beta Gamma Sigma</div>' +
          '<div role="option">Other</div>' +
          '</div>';
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') document.getElementById('menu').innerHTML = '';
      });
    </script></body></html>`;

  it("opens a combobox, reads its real options, and marks it CLOSED", async () => {
    await withFixtureHtmlPage(REACT_SELECT, async (page) => {
      const fields = discoverFieldsFromHtml(REACT_SELECT);
      // The premise of the whole fix: HTML discovery sees no options here.
      const orgFromHtml = fields.find((f) => f.id === "org");
      expect(orgFromHtml?.options ?? []).toEqual([]);

      const harvest = await harvestFieldOptions(page, fields);
      expect(harvest.options.get("org")).toEqual([
        "Alpha Kappa Psi",
        "Beta Gamma Sigma",
        "Other",
      ]);
      expect(harvest.answerSpace.get("org")).toBe("closed");
      const record = harvest.harvested.find((h) => h.field_id === "org");
      expect(record?.basis).toBe("opened_listbox");
      expect(record?.other_option).toBe("Other");
    });
  }, 45_000);

  it("leaves the control's value untouched — harvesting never commits a choice", async () => {
    await withFixtureHtmlPage(REACT_SELECT, async (page) => {
      await harvestFieldOptions(page, discoverFieldsFromHtml(REACT_SELECT));
      expect(await page.locator("#org").inputValue()).toBe("");
    });
  }, 45_000);

  it("classifies a plain text input as an OPEN answer space", async () => {
    const html = `<!DOCTYPE html><html><body>
      <label for="why">Why do you want this role</label>
      <input id="why" name="why" type="text" />
    </body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const harvest = await harvestFieldOptions(page, discoverFieldsFromHtml(html));
      expect(harvest.answerSpace.get("why")).toBe("open");
      expect(harvest.options.has("why")).toBe(false);
    });
  }, 45_000);

  it('a "No options" row is a status message, never an answer', async () => {
    const html = `<!DOCTYPE html><html><body>
      <label for="s">School</label>
      <div class="select__control" id="s-shell"><input id="s" name="s" role="combobox" /></div>
      <div id="m"></div>
      <script>
        document.getElementById('s-shell').addEventListener('click', () => {
          document.getElementById('m').innerHTML =
            '<div role="listbox"><div role="option">No options</div></div>';
        });
      </script></body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const harvest = await harvestFieldOptions(page, discoverFieldsFromHtml(html));
      expect(harvest.options.has("s")).toBe(false);
      // A select-like that shows nothing real is NOT reclassified as open —
      // typing into it is precisely the blind-typeahead bug.
      expect(harvest.answerSpace.get("s")).toBeUndefined();
      expect(harvest.notes.join(" ")).toMatch(/no readable options/);
    });
  }, 45_000);

  it("reads a native select's options live (SPA-populated after first paint)", async () => {
    const html = `<!DOCTYPE html><html><body>
      <label for="deg">Degree</label>
      <select id="deg" name="deg"></select>
      <script>
        const s = document.getElementById('deg');
        for (const t of ["Bachelor's Degree", "Master's Degree"]) {
          const o = document.createElement('option'); o.textContent = t; s.appendChild(o);
        }
      </script></body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const fields = discoverFieldsFromHtml(html);
      expect(fields.find((f) => f.id === "deg")?.options ?? []).toEqual([]);
      const harvest = await harvestFieldOptions(page, fields);
      expect(harvest.options.get("deg")).toEqual([
        "Bachelor's Degree",
        "Master's Degree",
      ]);
      expect(harvest.harvested[0]?.basis).toBe("native_select");
    });
  }, 45_000);

  it("a control that will not open contributes nothing and never throws", async () => {
    const html = `<!DOCTYPE html><html><body>
      <label for="dead">Pick one</label>
      <div class="select__control"><input id="dead" name="dead" role="combobox" /></div>
    </body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const harvest = await harvestFieldOptions(page, discoverFieldsFromHtml(html));
      expect(harvest.options.size).toBe(0);
      expect(harvest.harvested).toEqual([]);
    });
  }, 45_000);
});

describe("findOtherOption (UNIT_CONFIRMED)", () => {
  it("recognizes the form's own not-listed escape hatch", () => {
    expect(findOtherOption(["Alpha", "Beta", "Other"])).toBe("Other");
    expect(findOtherOption(["Yale", "Other (please specify)"])).toBe(
      "Other (please specify)",
    );
    expect(findOtherOption(["A", "Other", "Other (please specify)"])).toBe("Other");
    expect(findOtherOption(["A", "None of the above"])).toBe("None of the above");
  });

  it("a decline option is NOT an other option — declining changes the answer", () => {
    // Answering "Prefer not to say" on the candidate's behalf puts words in
    // their mouth; "Other" only says "not on your list", which is a fact.
    expect(findOtherOption(["Man", "Woman", "Prefer not to say"])).toBeNull();
    expect(findOtherOption(["Yes", "No", "Decline to answer"])).toBeNull();
  });

  it("returns null when the form offers no escape hatch", () => {
    expect(findOtherOption(["Yes", "No"])).toBeNull();
    expect(findOtherOption([])).toBeNull();
  });
});

describe("applyHarvestedOptions (UNIT_CONFIRMED)", () => {
  const field = (over: Partial<DiscoveredField>): DiscoveredField => ({
    id: "x",
    label: "X",
    type: "select",
    required: false,
    ...over,
  });

  it("fills in what the markup could not say", () => {
    const out = applyHarvestedOptions(
      [field({ id: "a" })],
      new Map([["a", ["One", "Two"]]]),
    );
    expect(out[0]?.options).toEqual(["One", "Two"]);
  });

  it("never overwrites options the HTML already declared", () => {
    const out = applyHarvestedOptions(
      [field({ id: "a", options: ["Real"] })],
      new Map([["a", ["Scraped"]]]),
    );
    expect(out[0]?.options).toEqual(["Real"]);
  });
});

/**
 * "if other provides another field space then its a free-text class" —
 * the revealed box is an OPEN answer space and takes the real answer.
 */
describe("pickSpecifyField (UNIT_CONFIRMED)", () => {
  const f = (over: Partial<DiscoveredField>): DiscoveredField => ({
    id: "n",
    label: "",
    type: "text",
    required: false,
    ...over,
  });

  it("prefers a box that names itself as the specify box", () => {
    const picked = pickSpecifyField(
      [f({ id: "a", label: "Unrelated question" }), f({ id: "b", label: "If other, please specify" })],
      "University organizations",
    );
    expect(picked?.id).toBe("b");
  });

  it("matches a box that shares the parent question's wording", () => {
    const picked = pickSpecifyField(
      [f({ id: "a", label: "Referral source" }), f({ id: "b", label: "University organizations detail" })],
      "University organizations",
    );
    expect(picked?.id).toBe("b");
  });

  it("takes a single unnamed new box — the causal link carries it", () => {
    expect(pickSpecifyField([f({ id: "solo", label: "" })], "Anything")?.id).toBe(
      "solo",
    );
  });

  it("refuses to guess between two unrelated new boxes", () => {
    expect(
      pickSpecifyField(
        [f({ id: "a", label: "Phone" }), f({ id: "b", label: "Address" })],
        "University organizations",
      ),
    ).toBeNull();
  });

  it("a newly revealed DROPDOWN is a fresh closed question, not a specify box", () => {
    expect(
      pickSpecifyField(
        [f({ id: "a", label: "Which other", type: "select", options: ["X", "Y"] })],
        "Organizations",
      ),
    ).toBeNull();
  });
});
