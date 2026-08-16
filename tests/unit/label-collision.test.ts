import { describe, expect, it } from "vitest";
import {
  greenhouseFillFromPlan,
  greenhouseVerifyFromPlan,
  locatorForField,
  type FieldMeta,
} from "../../src/ats/greenhouse/fill.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";
import type { FillPlanEntry } from "../../src/applications/resolveAnswers.js";

/**
 * Label collision + fast-fail (improve cycle on the 2026-08-16 neuralink
 * run, artifact live-fill-report 19:14Z).
 *
 * Two failure classes from that report:
 *   1. The plan's "LinkedIn" URL entry resolved via getByLabel onto the
 *      how-did-you-hear "LinkedIn" CHECKBOX — the URL went into a
 *      checkbox, verify read `true`, the real LinkedIn input stayed
 *      empty. Labels are not unique; the control class must discriminate.
 *   2. f_28 burned 30 seconds inside locator.evaluate waiting for a label
 *      that was never going to appear — a missing control must be an
 *      instant, NAMED error.
 */

/** A page with the neuralink collision shape: same label, two controls. */
const COLLISION_HTML = `<!DOCTYPE html><html><body>
  <h2>How did you hear about us? (check all that apply)</h2>
  <label><input type="checkbox" id="hdyh_li" /> LinkedIn</label>
  <label><input type="checkbox" id="hdyh_gd" /> Glassdoor</label>

  <label for="li_url">LinkedIn</label>
  <input id="li_url_input" aria-label="LinkedIn" type="text" />

  <label for="onsite_ack"><input type="checkbox" id="onsite_ack" aria-label="I understand that this position requires me to work on-site." />
    I understand that this position requires me to work on-site.</label>
</body></html>`;

// The fill loop only executes APPROVED entries — build that shape directly.
const entry = (over: Record<string, unknown>) =>
  ({
    field_id: "x",
    label: "X",
    type: "text",
    required: false,
    action: "FILL",
    approved: true,
    value: "v",
    canonical_field: null,
    reason: "test",
    ...over,
  }) as never;

describe("label collision (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("fixture_fill");

  it("a TEXT entry labeled like a checkbox option lands on the text input", async () => {
    await withFixtureHtmlPage(COLLISION_HTML, async (page) => {
      const e = entry({
        field_id: "li",
        label: "LinkedIn",
        type: "text",
        value: "https://www.linkedin.com/in/ada",
        canonical_field: "linkedin_url",
      });
      const meta = new Map<string, FieldMeta>([["li", { type: "text" }]]);
      const fill = await greenhouseFillFromPlan(page, [e], meta);
      expect(fill.errors).toEqual([]);
      // The URL is in the INPUT…
      expect(await page.locator("#li_url_input").inputValue()).toBe(
        "https://www.linkedin.com/in/ada",
      );
      // …and the same-label checkbox was never touched.
      expect(await page.locator("#hdyh_li").isChecked()).toBe(false);
      // Verify reads the same control — no more `true` off the checkbox.
      const verify = await greenhouseVerifyFromPlan(page, [e], meta);
      expect(verify.fields[0]?.match).toBe(true);
    });
  }, 45_000);

  it("a CHECKBOX entry never lands on a same-label text input", async () => {
    await withFixtureHtmlPage(COLLISION_HTML, async (page) => {
      const e = entry({
        field_id: "ack",
        label: "I understand that this position requires me to work on-site.",
        type: "checkbox",
        value: "Yes",
        canonical_field: "screener:custom:onsite_ack",
      });
      const meta = new Map<string, FieldMeta>([["ack", { type: "checkbox" }]]);
      const fill = await greenhouseFillFromPlan(page, [e], meta);
      expect(fill.errors).toEqual([]);
      expect(await page.locator("#onsite_ack").isChecked()).toBe(true);
      // Checked box verifies as a match for expected "Yes".
      const verify = await greenhouseVerifyFromPlan(page, [e], meta);
      expect(verify.fields[0]?.match).toBe(true);
    });
  }, 45_000);

  it("locatorForField without a type keeps today's behavior (first label match)", async () => {
    await withFixtureHtmlPage(COLLISION_HTML, async (page) => {
      const loc = locatorForField(page, { field_id: "li", label: "LinkedIn" });
      expect(await loc.count()).toBeGreaterThan(0);
    });
  }, 45_000);

  it("a missing control fails INSTANTLY with a named error, not a 30s hang", async () => {
    await withFixtureHtmlPage(COLLISION_HTML, async (page) => {
      const e = entry({
        field_id: "ghost",
        label: "A question that is not on this page at all",
        type: "text",
        value: "anything",
        canonical_field: "screener:custom:ghost_question",
      });
      const start = Date.now();
      const fill = await greenhouseFillFromPlan(page, [e], new Map());
      const elapsed = Date.now() - start;
      expect(fill.errors.join(" ")).toMatch(/control not found on the page/);
      expect(elapsed).toBeLessThan(10_000); // was 30s+ per field (live f_28)
      // Verify on the same ghost also fails fast with the named warning.
      const vStart = Date.now();
      const verify = await greenhouseVerifyFromPlan(page, [e], new Map());
      expect(Date.now() - vStart).toBeLessThan(10_000);
      expect(verify.warnings.join(" ")).toMatch(/control not found on the page/);
    });
  }, 45_000);
});
