import { describe, expect, it } from "vitest";
import { walkGenericFormPages } from "../../src/applications/genericFormAdvance.js";
import { resolveSubmitControl } from "../../src/ats/shared/submitControl.js";
import { genericSelectorsV1 } from "../../src/ats/generic/selectors.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";

describe("generic form-page advance (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  it("clicks Continue To Application, fills the next page, then leaves Submit alone", async () => {
    const html = `<!DOCTYPE html><html><body>
      <form id="f">
        <div id="step">
          <label>Phone<input name="phone" /></label>
          <button type="submit">Continue To Application</button>
        </div>
      </form>
      <script>
        document.getElementById("f").addEventListener("submit", (e) => {
          e.preventDefault();
          document.getElementById("step").innerHTML =
            '<label>First<input name="first_name" required /></label>' +
            '<button type="submit">Submit application</button>';
        });
      </script>
    </body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      let fills = 0;
      const walk = await walkGenericFormPages(
        page,
        async () => {
          fills += 1;
          return { fillable: 1, filled: 1, verifyPassed: true };
        },
        { settleMs: 5_000 },
      );
      expect(fills).toBe(1);
      expect(walk.pages).toHaveLength(1);
      expect(walk.verifyFailed).toBe(false);
      const submit = await resolveSubmitControl(
        walk.page,
        genericSelectorsV1.submitCascade,
      );
      expect(submit.found).toBe(true);
    });
  }, 30_000);

  it("does not click when a real submit control is already visible", async () => {
    const html = `<form>
      <input name="first_name" />
      <button type="submit">Submit application</button>
    </form>`;
    await withFixtureHtmlPage(html, async (page) => {
      let fills = 0;
      const walk = await walkGenericFormPages(page, async () => {
        fills += 1;
        return { fillable: 1, filled: 1, verifyPassed: true };
      });
      expect(fills).toBe(0);
      expect(walk.pages).toHaveLength(0);
      expect(walk.notes.join(" ")).toMatch(/leaving it for the gated submit path/);
    });
  }, 30_000);
});
