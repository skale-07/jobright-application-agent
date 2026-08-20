import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import {
  captureExtensionSession,
  diffPageStates,
  collectPageState,
} from "../../src/jobright/extension/capture.js";

/**
 * X1 extension-capture: the operator activates the extension by hand and
 * the capture only observes. The "activation" here is a synthetic DOM
 * mutation through the waitForOperator seam — FIXTURE_CONFIRMED for the
 * observation/diff/scrub mechanics; the real extension stays UNVERIFIED
 * until an operator capture.
 */
const FORM = `<!doctype html><html><body>
  <button id="jobright-autofill-btn" class="jr-trigger">Autofill with JobRight</button>
  <form>
    <label for="first">First Name</label><input id="first" type="text" />
    <label for="email">Email</label><input id="email" type="email" />
    <label for="phone">Phone</label><input id="phone" type="tel" />
  </form>
</body></html>`;

describe("extension capture (FIXTURE_CONFIRMED)", () => {
  it("diffs field classes, spots new panel DOM, and persists no raw values", async () => {
    const outDir = path.join(os.tmpdir(), `jaa-extcap-${randomUUID()}`);
    try {
      await withFixtureHtmlPage(FORM, async (page) => {
        const report = await captureExtensionSession({
          page,
          url: "https://jobs.example.test/apply/1",
          outDirOverride: outDir,
          waitForOperator: async () => {
            await page.evaluate(`(() => {
              document.getElementById("first").value = "Shubham";
              document.getElementById("email").value = "sk.secret@example.com";
              const panel = document.createElement("div");
              panel.id = "jobright-fill-summary";
              panel.textContent = "Filled 2 fields";
              document.body.appendChild(panel);
            })()`);
          },
        });
        expect(report.diff.filled_count).toBe(2);
        expect(report.trigger_candidates.join(" ")).toMatch(
          /jobright-autofill-btn/,
        );
        expect(report.diff.new_element_ids).toContain("jobright-fill-summary");
        const phone = report.diff.field_changes.find(
          (c) => c.field_id === "phone",
        );
        expect(phone?.changed).toBe(false);
      });

      // PII rule: nothing raw in any written artifact.
      const files = fs.readdirSync(outDir);
      expect(files.sort()).toEqual([
        "after.html",
        "before.html",
        "diff.json",
        "selector-candidates.json",
      ]);
      for (const f of files) {
        const text = fs.readFileSync(path.join(outDir, f), "utf8");
        expect(text).not.toContain("Shubham");
        expect(text).not.toContain("sk.secret@example.com");
      }
      const after = fs.readFileSync(path.join(outDir, "after.html"), "utf8");
      expect(after).toContain("jobright-fill-summary");
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("collect+diff are stable when nothing changes", async () => {
    await withFixtureHtmlPage(FORM, async (page) => {
      const a = await collectPageState(page);
      const b = await collectPageState(page);
      const diff = diffPageStates(a, b);
      expect(diff.filled_count).toBe(0);
      expect(diff.new_element_ids).toEqual([]);
      expect(diff.new_frame_urls).toEqual([]);
      expect(diff.field_changes.every((c) => !c.changed)).toBe(true);
    });
  }, 45_000);
});
