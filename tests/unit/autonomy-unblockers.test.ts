import { describe, expect, it } from "vitest";
import { isAdvisoryReviewItem, isRetryablePortalAuthWall, PORTAL_AUTH_WALL_TITLE } from "../../src/queue/reviewItems.js";
import { ATS_BINDINGS } from "../../src/applications/atsBindings.js";
import {
  heldAnswerFromReason,
  isOptionMismatchReview,
  selectScreenerOptions,
} from "../../src/applications/screenerOptionSelect.js";
import { generateEssayAnswers } from "../../src/applications/essayAutofill.js";
import {
  discoverFieldsFromHtml,
  isUninformativeLabel,
  nearestSectionHeading,
} from "../../src/applications/fieldDiscovery.js";
import { resetConfigCache } from "../../src/config/index.js";
import {
  applyControlledFillEnv,
  applySafeFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";

/**
 * The blockers measured across the live fill reports: 20 review items on
 * one Lever form with the answer already in the bank, 72 fields skipped
 * for "No answer-alias mapping" (~40 of them Lever education cards), and
 * a pipeline that halts on ANY open review item.
 */
describe("advisory review items no longer freeze an application (UNIT_CONFIRMED)", () => {
  it("treats field-level notes as advisory", () => {
    for (const title of [
      'Answer needed: "How did you learn about this opportunity?"',
      "New question learned: OPT status",
      "Submit selector proposal for lever",
    ]) {
      expect(isAdvisoryReviewItem({ kind: "MANUAL", title })).toBe(true);
    }
  });

  it("still halts on every real wall", () => {
    // MANUAL items that name a wall keep blocking.
    for (const title of [
      "Navigation blocked by employer identity wall",
      "Resume material not registered",
      "Employer application URL unknown",
      "Wrong-employer URL stored",
    ]) {
      expect(isAdvisoryReviewItem({ kind: "MANUAL", title })).toBe(false);
    }
    for (const kind of [
      "AUTH_REQUIRED",
      "CAPTCHA_REQUIRED",
      "UNCERTAIN_SUBMISSION",
      "AMBIGUOUS_FIELD",
      "UNSUPPORTED_ATS",
      "ESSAY",
      "DUPLICATE_RISK",
    ] as const) {
      expect(isAdvisoryReviewItem({ kind, title: "Answer needed: x" })).toBe(false);
    }
  });

  it("employer sign-in walls are retryable only when standing portal creds exist", () => {
    const item = { kind: "MANUAL" as const, title: PORTAL_AUTH_WALL_TITLE };
    expect(isRetryablePortalAuthWall(item, undefined)).toBe(false);
    expect(isRetryablePortalAuthWall(item, "")).toBe(false);
    expect(isRetryablePortalAuthWall(item, "standing-secret")).toBe(true);
    expect(
      isRetryablePortalAuthWall(
        { kind: "MANUAL", title: "Resume material not registered" },
        "standing-secret",
      ),
    ).toBe(false);
  });
});

describe("healing is on for every fill-capable ATS (UNIT_CONFIRMED)", () => {
  it("no adapter leaves a single read-back miss terminal", () => {
    // The healer's locator is vendor-free label similarity with a
    // deterministic re-verify; it was switched on for greenhouse only,
    // which made one verify miss fatal on lever/ashby/workable/workday.
    for (const id of [
      "greenhouse",
      "lever",
      "ashby",
      "workable",
      "workday",
      "generic",
    ] as const) {
      expect(ATS_BINDINGS[id].supportsHealing).toBe(true);
    }
  });
});

describe("screener option selection (UNIT_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  const REASON =
    'how_heard: bank answer "JobRight" matches none of the 13 page options — review';

  it("recognises an option-mismatch park and recovers the held answer", () => {
    expect(
      isOptionMismatchReview({ status: "review", key: "how_heard", reason: REASON }),
    ).toBe(true);
    expect(heldAnswerFromReason(REASON)).toBe("JobRight");
    // A policy park is NOT an option mismatch — no model call for those.
    expect(
      isOptionMismatchReview({
        status: "review",
        key: "salary",
        reason: "salary is a human decision by policy",
      }),
    ).toBe(false);
  });

  it("fills only with an option that exists verbatim on the page", async () => {
    applyControlledFillEnv({ SCREENER_LLM_MATCH_ENABLED: "true" });
    resetConfigCache();
    try {
      const client = {
        generateJson: async () => ({
          text: JSON.stringify({
            choices: [
              { key: "a", option: "Job board" },
              // Invented — must be rejected, not filled.
              { key: "b", option: "JobRight (referral)" },
              // Explicit abstention.
              { key: "c", option: null },
            ],
          }),
        }),
      } as never;
      const out = await selectScreenerOptions({
        items: [
          { key: "a", question: "How did you hear about us?", answer: "JobRight", options: ["Job board", "Referral", "Other"] },
          { key: "b", question: "How did you hear about us?", answer: "JobRight", options: ["Referral", "Other"] },
          { key: "c", question: "Are you able to work onsite?", answer: "Remote", options: ["Yes", "No"] },
        ],
        client,
      });
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ key: "a", option: "Job board", basis: "llm_option" });
    } finally {
      applySafeFillEnv();
      resetConfigCache();
    }
  });

  it("is a no-op while its flag is off", async () => {
    applySafeFillEnv();
    resetConfigCache();
    const out = await selectScreenerOptions({
      items: [{ key: "a", question: "q", answer: "JobRight", options: ["Job board"] }],
    });
    expect(out).toEqual([]);
  });
});

describe("essay autofill (UNIT_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  it("rejects a draft that fails the same validator a review draft faces", async () => {
    const client = {
      generateJson: async () => ({
        text: JSON.stringify({ answer: "Too short to be an essay answer." }),
      }),
    } as never;
    const out = await generateEssayAnswers({
      items: [{ fieldId: "f1", question: "Why this company?" }],
      client,
    });
    expect(out.answers).toEqual([]);
    expect(out.notes.join(" ")).toMatch(/rejected|no about-me context/);
  });

  it("treats an explicit model abstention as a park, never an empty fill", async () => {
    const client = {
      generateJson: async () => ({ text: JSON.stringify({ answer: null }) }),
    } as never;
    const out = await generateEssayAnswers({
      items: [{ fieldId: "f1", question: "Describe a project" }],
      client,
    });
    expect(out.answers).toEqual([]);
  });
});

describe("label resolution for machine-named fields (UNIT_CONFIRMED)", () => {
  it("recognises the shapes that are not questions", () => {
    for (const bad of [
      "cards[631785a2-31a3-4f63-b226-13d3d23f85e0][field0]",
      "urls[Other]",
      "field_33",
      "Type your response",
      "79abc513-4541-4e6b-a078-a09ce0ca65ca",
      "Select...",
    ]) {
      expect(isUninformativeLabel(bad)).toBe(true);
    }
    for (const good of [
      "How did you learn about this opportunity?",
      "School",
      "Are you currently in a period of Optional Practical Training (OPT)?",
    ]) {
      expect(isUninformativeLabel(good)).toBe(false);
    }
  });

  it("recovers the question from the nearest heading", () => {
    const html = `<form><fieldset><legend>Education</legend>
      <input name="cards[631785a2-31a3-4f63-b226-13d3d23f85e0][field0]" />
    </fieldset></form>`;
    expect(nearestSectionHeading(html, html.indexOf("<input"))).toBe("Education");
    const fields = discoverFieldsFromHtml(html);
    expect(fields[0]?.label).toBe("Education");
  });

  it("leaves a real label alone", () => {
    const html = `<form><h2>Application</h2>
      <label for="e">Email address</label><input id="e" name="email" />
    </form>`;
    expect(discoverFieldsFromHtml(html)[0]?.label).toBe("Email address");
  });

  it("returns null rather than guessing when nothing informative precedes", () => {
    const html = `<form><input name="cards[abc][field0]" /></form>`;
    expect(nearestSectionHeading(html, html.indexOf("<input"))).toBeNull();
  });
});
