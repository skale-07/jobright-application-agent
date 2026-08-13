import { describe, expect, it } from "vitest";
import {
  applyLeverCardQuestions,
  discoverLeverCardQuestions,
} from "../../src/ats/lever/cardQuestions.js";
import { discoverFieldsFromHtml } from "../../src/applications/fieldDiscovery.js";

/**
 * Lever custom-question cards — fixture copied from the LIVE Field AI form
 * snapshot where 60 fields reached the plan labeled "Type your response"
 * or a bare cards[uuid][fieldN] name. UNIT_CONFIRMED against that shape.
 */
const CARD_HTML = `
<div class="section page-centered application-form" data-qa="additional-cards">
  <h4 data-qa="card-name">Employment Eligibility &amp; Certifications</h4>
  <input type="hidden" value="x" name="cards[a74e185d-d12d-407a-9087-fb45c6ad1892][baseTemplate]">
  <ul>
    <li class="application-question custom-question">
      <div>
        <div class="application-label full-width multiple-choice">
          <div class="text">Are you legally authorized to work in the country where this position is located?<span class="required">✱</span></div>
        </div>
        <div class="application-field full-width required-field">
          <ul data-qa="multiple-choice">
            <li><label><input type="radio" name="cards[a74e185d-d12d-407a-9087-fb45c6ad1892][field0]" value="0" required="required"><span class="application-answer-alternative">Yes</span></label></li>
            <li><label><input type="radio" name="cards[a74e185d-d12d-407a-9087-fb45c6ad1892][field0]" value="1" required="required"><span class="application-answer-alternative">No</span></label></li>
          </ul>
        </div>
      </div>
    </li>
    <li class="application-question custom-question">
      <div>
        <div class="application-label full-width">
          <div class="text">What excites you about Field AI?<span class="required">✱</span></div>
        </div>
        <div class="application-field full-width required-field">
          <textarea name="cards[a74e185d-d12d-407a-9087-fb45c6ad1892][field5]" placeholder="Type your response" required="required"></textarea>
        </div>
      </div>
    </li>
  </ul>
</div>`;

describe("lever card-question labeling (UNIT_CONFIRMED)", () => {
  it("extracts real question text, options, and required from card blocks", () => {
    const cards = discoverLeverCardQuestions(CARD_HTML);
    const radio = cards.get("cards[a74e185d-d12d-407a-9087-fb45c6ad1892][field0]");
    expect(radio?.label).toBe(
      "Are you legally authorized to work in the country where this position is located?",
    );
    expect(radio?.options).toEqual(["Yes", "No"]);
    expect(radio?.required).toBe(true);
    const essay = cards.get("cards[a74e185d-d12d-407a-9087-fb45c6ad1892][field5]");
    expect(essay?.label).toBe("What excites you about Field AI?");
  });

  it("overlay replaces placeholder labels in generic discovery output", () => {
    const generic = discoverFieldsFromHtml(CARD_HTML);
    // The live regression: generic discovery cannot see the real question,
    // so it falls back to the nearest section heading ("Type your
    // response" is now recognised as a placeholder, not a question).
    // Useful, but not the actual question — the overlay below is.
    const before = generic.find((f) => (f.name ?? "").endsWith("[field5]"));
    expect(before?.label).not.toBe("What excites you about Field AI?");
    expect(before?.label).toMatch(/Employment Eligibility & Certifications/);

    const fixed = applyLeverCardQuestions(generic, CARD_HTML);
    const essay = fixed.find((f) => (f.name ?? "").endsWith("[field5]"));
    expect(essay?.label).toBe("What excites you about Field AI?");
    const radioGroup = fixed.find((f) => (f.name ?? "").endsWith("[field0]"));
    expect(radioGroup?.label).toMatch(/legally authorized to work/);
    expect(radioGroup?.options).toEqual(["Yes", "No"]);
    // Non-card fields pass through untouched.
    expect(
      applyLeverCardQuestions(
        [{ id: "email", label: "Email", type: "text", required: true }],
        CARD_HTML,
      )[0]!.label,
    ).toBe("Email");
  });
});
