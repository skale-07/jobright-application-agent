import { describe, expect, it } from "vitest";
import { reachGreenhouseApplicationForm } from "../../src/ats/greenhouse/liveFill.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";

const REQUESTED =
  "https://job-boards.greenhouse.io/jumptrading/jobs/8003019";

const FORM_HTML = `<form id="application_form">
  <label>First Name<input name="first_name" id="first_name"/></label>
  <label>Email<input type="email" name="email" id="email"/></label>
</form>`;

describe("reachGreenhouseApplicationForm (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  it("clicks Apply on a posting shell and re-gates on the revealed form", async () => {
    const html = `<!DOCTYPE html><html><body>
      <div id="stage">
        <h1>Campus UI Software Engineer</h1>
        <p>About the role.</p>
        <button id="apply">Apply</button>
      </div>
      <script>
        document.getElementById('apply').addEventListener('click', () => {
          document.getElementById('stage').innerHTML = ${JSON.stringify(FORM_HTML)};
        });
      </script>
    </body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const r = await reachGreenhouseApplicationForm(page, REQUESTED, REQUESTED);
      expect(r.gate.ok).toBe(true);
      expect(r.gate.failureCode).toBeNull();
      expect(r.gate.html).toContain("application_form");
      expect(r.notes.join(" ")).toMatch(/landed on a posting|unknown landing/);
    });
  }, 45_000);

  it("does not click Apply when the landing is already a Greenhouse form", async () => {
    const html = `<!DOCTYPE html><html><body>${FORM_HTML}</body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const r = await reachGreenhouseApplicationForm(page, REQUESTED, REQUESTED);
      expect(r.gate.ok).toBe(true);
      expect(r.notes).toEqual([]);
      expect(await page.locator("#application_form").count()).toBe(1);
    });
  }, 45_000);

  it("hops a Greenhouse embed despite listing search chrome and no Apply button", async () => {
    const embedUrl =
      "https://job-boards.greenhouse.io/embed/job_app?for=test&token=8003019";
    const outer = `<!DOCTYPE html><html><body>
      <h1>Campus UI Software Engineer</h1>
      <p>Apply now for this role.</p>
      <label>Search jobs<input name="q" placeholder="Search by job title"/></label>
      <iframe src="${embedUrl}"></iframe>
    </body></html>`;
    await withFixtureHtmlPage("<html><body></body></html>", async (page) => {
      await page.context().route("**/*", (route) =>
        route.fulfill({
          body: route.request().url().includes("/embed/job_app")
            ? `<!DOCTYPE html><html><body>${FORM_HTML}</body></html>`
            : outer,
          contentType: "text/html",
        }),
      );
      await page.goto(REQUESTED, { waitUntil: "domcontentloaded" });
      const r = await reachGreenhouseApplicationForm(page, REQUESTED, REQUESTED);
      expect(r.gate.ok).toBe(true);
      expect(r.notes.join(" ")).toMatch(/hopping to/);
      expect(await page.locator("#application_form").count()).toBe(1);
    });
  }, 45_000);
});
