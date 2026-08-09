import { describe, expect, it } from "vitest";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import { scanRequiredCompleteness } from "../../src/ats/shared/requiredCompleteness.js";
import { redactObject } from "../../src/logging/redaction.js";

/**
 * The pre-click completeness gate, shaped on the real Cohere failure: a
 * filled form whose required Additional Questions were untouched clicked
 * Submit into client-side validation and ended UNCERTAIN. The scan names
 * every required-but-unanswered control BEFORE any click. FIXTURE_CONFIRMED.
 */
describe("required-completeness scan (FIXTURE_CONFIRMED)", () => {
  it("catches the Cohere shape: untouched required radios, select, and essay", async () => {
    const html = `
      <form>
        <label for="n">Name</label><input id="n" required value="Shubham" />
        <fieldset>
          <legend>Are you available for a full-time internship?</legend>
          <label><input type="radio" name="avail" required value="Yes" />Yes</label>
          <label><input type="radio" name="avail" required value="No" />No</label>
        </fieldset>
        <fieldset>
          <legend>Please select the current level of education you are pursuing</legend>
          <label><input type="radio" name="edu" required value="Undergrad" />Undergrad</label>
          <label><input type="radio" name="edu" required value="PhD" />PhD</label>
        </fieldset>
        <label for="fit">What makes you a good fit for Cohere?</label>
        <textarea id="fit" required></textarea>
        <label for="heard">How did you hear about this role?</label>
        <select id="heard" required>
          <option value="">Start typing...</option>
          <option>JobRight</option>
        </select>
        <button type="button">Submit application</button>
      </form>`;
    await withFixtureHtmlPage(html, async (page) => {
      const scan = await scanRequiredCompleteness(page);
      expect(scan.scanned).toBe(true);
      const labels = scan.unanswered.map((u) => u.label);
      expect(labels).toContain("Are you available for a full-time internship?");
      expect(labels).toContain(
        "Please select the current level of education you are pursuing",
      );
      expect(labels).toContain("What makes you a good fit for Cohere?");
      expect(labels).toContain("How did you hear about this role?");
      // The filled name field must NOT appear.
      expect(labels).not.toContain("Name");
      expect(scan.unanswered.map((u) => u.control)).toEqual(
        expect.arrayContaining(["radio_group", "textarea", "select"]),
      );
    });
  }, 30_000);

  it("catches the LIVE Ashby shape: asterisk-labeled role=radio groups with no aria-required", async () => {
    // The real submit gate refused only the essay textarea while two blank
    // required radio groups sailed past — Ashby marks required with ONLY a
    // trailing asterisk on the label, no [aria-required].
    const html = `
      <form>
        <div class="_fieldEntry_x1">
          <label id="l1">Are you able to work full time for the duration of the internship?<span>*</span></label>
          <div role="radiogroup" aria-labelledby="l1">
            <div role="radio" aria-checked="false" tabindex="0">Yes</div>
            <div role="radio" aria-checked="false" tabindex="-1">No</div>
          </div>
        </div>
        <div class="_fieldEntry_x1">
          <label id="l2">Please select the current level of education you are pursuing *</label>
          <div role="radiogroup" aria-labelledby="l2">
            <div role="radio" aria-checked="false">Undergraduate</div>
            <div role="radio" aria-checked="false">PhD</div>
          </div>
        </div>
        <div class="_fieldEntry_x1">
          <label id="l3">Which office is closest to you? *</label>
          <div role="radiogroup" aria-labelledby="l3">
            <div role="radio" aria-checked="true">Toronto</div>
            <div role="radio" aria-checked="false">London</div>
          </div>
        </div>
        <div class="_fieldEntry_x1">
          <label id="l4">Anything else you want to share? (optional)</label>
          <div role="radiogroup" aria-labelledby="l4">
            <div role="radio" aria-checked="false">Yes</div>
            <div role="radio" aria-checked="false">No</div>
          </div>
        </div>
        <button type="button">Submit application</button>
      </form>`;
    await withFixtureHtmlPage(html, async (page) => {
      const scan = await scanRequiredCompleteness(page);
      expect(scan.scanned).toBe(true);
      const labels = scan.unanswered.map((u) => u.label);
      expect(labels.join(" | ")).toMatch(/work full time/);
      expect(labels.join(" | ")).toMatch(/level of education/);
      // Answered group: not flagged. Unmarked optional group: not flagged.
      expect(labels.join(" | ")).not.toMatch(/closest to you/);
      expect(labels.join(" | ")).not.toMatch(/Anything else/);
      expect(
        scan.unanswered.filter((u) => u.control === "radio_group").length,
      ).toBe(2);
    });
  }, 30_000);

  it("a fully answered form passes clean", async () => {
    const html = `
      <form>
        <label for="n">Name</label><input id="n" required value="S" />
        <fieldset>
          <legend>Available?</legend>
          <label><input type="radio" name="a" required value="Yes" checked />Yes</label>
          <label><input type="radio" name="a" required value="No" />No</label>
        </fieldset>
        <label for="s">Source</label>
        <select id="s" required><option value="">--</option><option selected>JobRight</option></select>
        <label for="t">Essay</label><textarea id="t" required>done</textarea>
      </form>`;
    await withFixtureHtmlPage(html, async (page) => {
      const scan = await scanRequiredCompleteness(page);
      expect(scan.scanned).toBe(true);
      expect(scan.unanswered).toEqual([]);
    });
  }, 30_000);

  it("optional fields never block, hidden required fields never block", async () => {
    const html = `
      <form>
        <label for="opt">Optional referral</label><input id="opt" value="" />
        <input type="hidden" required value="" />
        <div style="display:none"><label for="h">Ghost</label><input id="h" required value="" /></div>
      </form>`;
    await withFixtureHtmlPage(html, async (page) => {
      const scan = await scanRequiredCompleteness(page);
      expect(scan.unanswered).toEqual([]);
    });
  }, 30_000);

  it("ARIA radiogroup and combobox widgets (Ashby-style) are covered", async () => {
    const html = `
      <div role="radiogroup" aria-required="true" aria-label="Education level">
        <div role="radio" aria-checked="false">Undergrad</div>
        <div role="radio" aria-checked="false">PhD</div>
      </div>
      <input role="combobox" aria-required="true" aria-label="How did you hear about this role?" placeholder="Start typing..." value="" />
      <div role="radiogroup" aria-required="true" aria-label="Answered group">
        <div role="radio" aria-checked="true">Yes</div>
      </div>`;
    await withFixtureHtmlPage(html, async (page) => {
      const scan = await scanRequiredCompleteness(page);
      const labels = scan.unanswered.map((u) => u.label);
      expect(labels).toContain("Education level");
      expect(labels).toContain("How did you hear about this role?");
      expect(labels).not.toContain("Answered group");
    });
  }, 30_000);
});

describe("redaction word-guard (UNIT_CONFIRMED)", () => {
  it("phase_trace survives; demographic keys still redact", () => {
    const out = redactObject({
      phase_trace: [{ phase: "A", outcome: "ok" }],
      trace_id: "abc",
      race_ethnicity: "x",
      race: "x",
      gender_identity: "x",
      agenda: "standup notes",
      phone: "555",
    });
    expect(Array.isArray(out["phase_trace"])).toBe(true);
    expect(out["trace_id"]).toBe("abc");
    expect(out["race_ethnicity"]).toBe("[REDACTED]");
    expect(out["race"]).toBe("[REDACTED]");
    expect(out["gender_identity"]).toBe("[REDACTED]");
    expect(out["agenda"]).toBe("standup notes");
    expect(out["phone"]).toBe("[REDACTED]");
  });
});
