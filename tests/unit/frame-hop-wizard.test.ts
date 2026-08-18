import { describe, expect, it } from "vitest";
import {
  findApplicationFrameUrl,
  isGreenhouseEmbedUrl,
} from "../../src/ats/shared/frameHop.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";

/**
 * Iframe-hosted forms (fix 4 of the 2026-08-14 batch). page.content()
 * excludes iframe content, so an embedded application form used to
 * discover ZERO fields and refuse NO_APPLICATION_FORM while a human saw a
 * form. findApplicationFrameUrl names the frame worth hopping to; the
 * live-fill runner then navigates there and re-runs the full gate.
 */
describe("isGreenhouseEmbedUrl (UNIT_CONFIRMED)", () => {
  it("matches embed/job_app, not the board posting", () => {
    expect(
      isGreenhouseEmbedUrl(
        "https://job-boards.greenhouse.io/embed/job_app?for=jumptrading&token=8003019",
      ),
    ).toBe(true);
    expect(
      isGreenhouseEmbedUrl("https://boards.greenhouse.io/embed/job_app?for=x"),
    ).toBe(true);
    expect(
      isGreenhouseEmbedUrl(
        "https://job-boards.greenhouse.io/jumptrading/jobs/8003019",
      ),
    ).toBe(false);
    expect(isGreenhouseEmbedUrl("https://media.example.com/video")).toBe(false);
  });
});

describe("iframe application-form hop (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  const EMBED_FORM_HTML = `<!DOCTYPE html><html><body>
    <form>
      <label>First Name<input name="first_name" /></label>
      <label>Last Name<input name="last_name" /></label>
      <label>Email<input type="email" name="email" /></label>
    </form></body></html>`;

  it("finds the frame whose document carries fillable fields", async () => {
    const outer = `<!DOCTYPE html><html><body>
      <h1>Join our team</h1>
      <iframe src="https://embed.ats-example.com/careers/apply/42"></iframe>
    </body></html>`;
    await withFixtureHtmlPage("<html><body></body></html>", async (page) => {
      await page.context().route("**/*", (route) =>
        route.fulfill({
          body: route.request().url().includes("embed.ats-example.com")
            ? EMBED_FORM_HTML
            : outer,
          contentType: "text/html",
        }),
      );
      await page.goto("https://careers.example-employer.com/jobs/42", {
        waitUntil: "domcontentloaded",
      });
      // Give the child frame a beat to load its routed document.
      await page.waitForTimeout(500);
      const hit = await findApplicationFrameUrl(page);
      expect(hit).not.toBeNull();
      expect(hit!.url).toBe("https://embed.ats-example.com/careers/apply/42");
      expect(hit!.fieldCount).toBeGreaterThanOrEqual(3);
    });
  }, 45_000);

  it("returns null when no frame carries a form (no false hop)", async () => {
    const outer = `<!DOCTYPE html><html><body>
      <h1>About us</h1>
      <iframe src="https://media.example.com/video/9"></iframe>
    </body></html>`;
    await withFixtureHtmlPage("<html><body></body></html>", async (page) => {
      await page.context().route("**/*", (route) =>
        route.fulfill({
          body: route.request().url().includes("media.example.com")
            ? "<html><body><p>a video player, no form</p></body></html>"
            : outer,
          contentType: "text/html",
        }),
      );
      await page.goto("https://careers.example-employer.com/about", {
        waitUntil: "domcontentloaded",
      });
      await page.waitForTimeout(500);
      expect(await findApplicationFrameUrl(page)).toBeNull();
    });
  }, 45_000);

  it("hops a Greenhouse embed URL even when the child document has no fields yet", async () => {
    const embedUrl =
      "https://job-boards.greenhouse.io/embed/job_app?for=test&token=1";
    const outer = `<!DOCTYPE html><html><body>
      <h1>Careers</h1>
      <iframe src="${embedUrl}"></iframe>
    </body></html>`;
    await withFixtureHtmlPage("<html><body></body></html>", async (page) => {
      await page.context().route("**/*", (route) =>
        route.fulfill({
          body: route.request().url().includes("/embed/job_app")
            ? "<html><body><p>loading</p></body></html>"
            : outer,
          contentType: "text/html",
        }),
      );
      await page.goto("https://www.jumptrading.com/hr/job?gh_jid=1", {
        waitUntil: "domcontentloaded",
      });
      await page.waitForTimeout(500);
      const hit = await findApplicationFrameUrl(page);
      expect(hit).not.toBeNull();
      expect(hit!.url).toBe(embedUrl);
      expect(hit!.fieldCount).toBe(0);
    });
  }, 45_000);

  it("does not hop a Greenhouse posting URL in an iframe", async () => {
    const posting =
      "https://job-boards.greenhouse.io/jumptrading/jobs/8003019";
    const outer = `<!DOCTYPE html><html><body>
      <iframe src="${posting}"></iframe>
    </body></html>`;
    await withFixtureHtmlPage("<html><body></body></html>", async (page) => {
      await page.context().route("**/*", (route) =>
        route.fulfill({
          body: route.request().url().includes("/jobs/8003019")
            ? "<html><body><p>job description</p></body></html>"
            : outer,
          contentType: "text/html",
        }),
      );
      await page.goto("https://www.jumptrading.com/hr/job?gh_jid=8003019", {
        waitUntil: "domcontentloaded",
      });
      await page.waitForTimeout(500);
      expect(await findApplicationFrameUrl(page)).toBeNull();
    });
  }, 45_000);

  it("hops a loopback http embed — the sandbox /fillhard shape", async () => {
    const embed = `<!DOCTYPE html><html><body>
      <form>
        <label>First Name<input name="first_name" /></label>
        <label>Email<input type="email" name="email" /></label>
      </form></body></html>`;
    const outer = `<!DOCTYPE html><html><body>
      <h1>Careers</h1>
      <iframe src="http://127.0.0.1/fillhard/embed"></iframe>
    </body></html>`;
    await withFixtureHtmlPage("<html><body></body></html>", async (page) => {
      await page.context().route("**/*", (route) =>
        route.fulfill({
          body: route.request().url().includes("/fillhard/embed")
            ? embed
            : outer,
          contentType: "text/html",
        }),
      );
      await page.goto("http://127.0.0.1/fillhard", {
        waitUntil: "domcontentloaded",
      });
      await page.waitForTimeout(500);
      const hit = await findApplicationFrameUrl(page);
      expect(hit).not.toBeNull();
      expect(hit!.url).toBe("http://127.0.0.1/fillhard/embed");
      expect(hit!.fieldCount).toBeGreaterThanOrEqual(2);
    });
  }, 45_000);
});

/**
 * Workday multi-page wizard walk (fix 5). Crowe live: a 7-step wizard got
 * only its landing page filled; every later page's required questions were
 * never even seen, so submit refused on "unanswered questions". The walk
 * clicks Next → settles → re-plans → re-fills, bounded, and NEVER touches
 * the submit button — the gated submit path owns that click.
 */
describe("workday wizard walk (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("fixture_fill");

  it("fills the page BEHIND Next and stops at review without submitting", async () => {
    const { walkWorkdayWizard } = await import(
      "../../src/applications/workdayWizard.js"
    );
    const WIZARD_SPA = `<!DOCTYPE html><html><body>
      <div data-automation-id="progressBar">My Information · My Experience · Review</div>
      <div id="stage">
        <label>First Name<input data-automation-id="legalNameSection_firstName" name="firstName" /></label>
        <label>Last Name<input data-automation-id="legalNameSection_lastName" name="lastName" /></label>
        <button data-automation-id="bottom-navigation-next-button" type="button">Next</button>
      </div>
      <script>
        let step = 1;
        document.addEventListener('click', (e) => {
          const t = e.target;
          if (!(t instanceof HTMLElement)) return;
          if (t.getAttribute('data-automation-id') === 'bottom-navigation-next-button') {
            step += 1;
            if (step === 2) {
              document.getElementById('stage').innerHTML =
                '<label>Email<input data-automation-id="email" type="email" name="email" /></label>' +
                '<button data-automation-id="bottom-navigation-next-button" type="button">Next</button>';
            } else {
              document.getElementById('stage').innerHTML =
                '<h2>Review</h2><p>Check your application.</p>' +
                '<button data-automation-id="bottom-navigation-submit-button" type="button">Submit</button>';
              document.querySelector('[data-automation-id=bottom-navigation-submit-button]')
                .addEventListener('click', () => { (globalThis).__submitted = true; });
            }
          }
        });
      </script></body></html>`;

    await withFixtureHtmlPage(WIZARD_SPA, async (page) => {
      const seenPages: string[] = [];
      const walk = await walkWorkdayWizard(
        page,
        async ({ html }) => {
          seenPages.push(html);
          // The filler sees the email page — fill it directly to prove the
          // page handed over is live and typable.
          await page.locator("[data-automation-id=email]").fill("ada@fixture.test");
          return { fillable: 1, filled: 1, verifyPassed: true };
        },
        { settleMs: 0 },
      );
      // Page 2 (the email page) was reached and handed to the filler.
      expect(walk.pages.length).toBe(1);
      expect(walk.pages[0]).toMatchObject({ page: 2, filled: 1, verify_passed: true });
      expect(seenPages[0]).toContain('data-automation-id="email"');
      expect(walk.verifyFailed).toBe(false);
      // The walk continued to review and STOPPED there.
      expect(await page.locator("[data-automation-id=email]").count()).toBe(0);
      expect(
        await page
          .locator("[data-automation-id=bottom-navigation-submit-button]")
          .count(),
      ).toBe(1);
      // The submit button was NEVER clicked.
      expect(
        await page.evaluate(() => (globalThis as unknown as { __submitted?: boolean }).__submitted),
      ).toBeUndefined();
      expect(walk.notes.join(" ")).toMatch(/wizard: filled 1 additional page/);
    });
  }, 45_000);

  it("stops immediately when Workday flags validation errors", async () => {
    const { walkWorkdayWizard } = await import(
      "../../src/applications/workdayWizard.js"
    );
    const ERROR_SPA = `<!DOCTYPE html><html><body>
      <div id="stage">
        <input data-automation-id="legalNameSection_firstName" name="firstName" />
        <button data-automation-id="bottom-navigation-next-button" type="button">Next</button>
      </div>
      <script>
        document.querySelector('[data-automation-id=bottom-navigation-next-button]')
          .addEventListener('click', () => {
            document.getElementById('stage').innerHTML =
              '<div data-automation-id="errorBanner">Please fix the errors below</div>' +
              '<input data-automation-id="legalNameSection_firstName" name="firstName" />' +
              '<button data-automation-id="bottom-navigation-next-button" type="button">Next</button>';
          });
      </script></body></html>`;
    await withFixtureHtmlPage(ERROR_SPA, async (page) => {
      let fillerCalls = 0;
      const walk = await walkWorkdayWizard(
        page,
        async () => {
          fillerCalls += 1;
          return { fillable: 0, filled: 0, verifyPassed: true };
        },
        { settleMs: 0 },
      );
      // The error banner stops the walk BEFORE any fill on that page —
      // missing required fields park for review, nothing is forced.
      expect(fillerCalls).toBe(0);
      expect(walk.verifyFailed).toBe(true);
      expect(walk.notes.join(" ")).toMatch(/flagged errors/);
    });
  }, 45_000);
});

/**
 * Wizard walk diagnostics (transition-strengthening pass, 2026-08-14):
 * a disabled Next names its blockers instead of a silent no-op, and a
 * mid-walk auth wall recovers ONCE through the caller's seam.
 */
describe("wizard walk diagnostics (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("fixture_fill");

  it("a DISABLED Next names the required fields blocking it", async () => {
    const { walkWorkdayWizard } = await import(
      "../../src/applications/workdayWizard.js"
    );
    const html = `<!DOCTYPE html><html><body>
      <label>Phone Device Type<select required aria-required="true"><option value="">Select One</option><option>Mobile</option></select></label>
      <button data-automation-id="bottom-navigation-next-button" type="button" disabled>Next</button>
    </body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      let fillerCalls = 0;
      const walk = await walkWorkdayWizard(
        page,
        async () => {
          fillerCalls += 1;
          return { fillable: 0, filled: 0, verifyPassed: true };
        },
        { settleMs: 0 },
      );
      expect(fillerCalls).toBe(0);
      expect(walk.verifyFailed).toBe(true);
      expect(walk.notes.join(" ")).toMatch(/Next disabled on page 1/);
      expect(walk.notes.join(" ")).toMatch(/Phone Device Type/);
    });
  }, 45_000);

  it("an auth wall mid-walk recovers ONCE through the seam and resumes", async () => {
    const { walkWorkdayWizard } = await import(
      "../../src/applications/workdayWizard.js"
    );
    // Page 1 → Next → session-expired sign-in page. The seam "signs in"
    // by swapping the DOM to the next wizard page; the walk resumes.
    const html = `<!DOCTYPE html><html><body>
      <div data-automation-id="progressBar">steps</div>
      <div id="stage">
        <input data-automation-id="legalNameSection_firstName" name="firstName" />
        <button data-automation-id="bottom-navigation-next-button" type="button">Next</button>
      </div>
      <script>
        document.querySelector('[data-automation-id=bottom-navigation-next-button]')
          .addEventListener('click', () => {
            document.getElementById('stage').innerHTML =
              '<h2>Sign In</h2>' +
              '<input data-automation-id="email" type="email" />' +
              '<input data-automation-id="password" type="password" />' +
              '<button data-automation-id="signInSubmitButton" type="button">Sign In</button>';
          });
        (globalThis).__signIn = () => {
          document.getElementById('stage').innerHTML =
            '<label>Email<input data-automation-id="email" type="email" name="email" /></label>';
        };
      </script></body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      let authCalls = 0;
      const walk = await walkWorkdayWizard(
        page,
        async () => ({ fillable: 1, filled: 1, verifyPassed: true }),
        {
          settleMs: 0,
          onAuthWall: async (p) => {
            authCalls += 1;
            await p.evaluate(() => (globalThis as unknown as { __signIn: () => void }).__signIn());
            return true;
          },
        },
      );
      expect(authCalls).toBe(1);
      expect(walk.notes.join(" ")).toMatch(/auth wall mid-walk — attempting portal sign-in/);
      expect(walk.notes.join(" ")).toMatch(/signed back in/);
      // The walk resumed and filled the page behind the wall.
      expect(walk.pages.length).toBe(1);
      expect(walk.pages[0]?.verify_passed).toBe(true);
      expect(walk.verifyFailed).toBe(false);
    });
  }, 45_000);
});
