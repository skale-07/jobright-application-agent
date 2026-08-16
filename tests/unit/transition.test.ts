import { describe, expect, it } from "vitest";
import { performTransition } from "../../src/browser/transition.js";
import { classifyPage } from "../../src/ats/shared/pageClassify.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";

/**
 * The shared page-to-page transition primitive (2026-08-14). Before it,
 * every hop was an ad-hoc click-plus-sleep with its own failure mode:
 * sleeps racing SPAs, stale snapshots, silent no-op clicks, flows
 * stranded when a click opened a new tab. One tested behavior now.
 */
describe("performTransition (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  it("detects a same-page SPA re-render and classifies the landing", async () => {
    const html = `<!DOCTYPE html><html><body>
      <div id="stage"><button id="go">Continue</button></div>
      <script>
        document.getElementById('go').addEventListener('click', () => {
          document.getElementById('stage').innerHTML =
            '<form><label>Email<input type="email" name="email"/></label></form>';
        });
      </script></body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const r = await performTransition(page, page.locator("#go"), {
        settleTimeoutMs: 5_000,
      });
      expect(r.landed).toBe(true);
      expect(r.adopted_popup).toBe(false);
      expect(r.retried).toBe(false);
      expect(r.classification.page_class).toBe("form");
      expect(r.classification.field_count).toBe(1);
    });
  }, 30_000);

  it("retries ONCE on a silent no-op click, then reports not landed", async () => {
    const html = `<!DOCTYPE html><html><body>
      <button id="dead">Next</button>
      <script>
        let clicks = 0;
        document.getElementById('dead').addEventListener('click', () => { clicks += 1; window.__clicks = clicks; });
      </script></body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const r = await performTransition(page, page.locator("#dead"), {
        settleTimeoutMs: 400,
      });
      expect(r.landed).toBe(false);
      expect(r.retried).toBe(true);
      expect(
        await page.evaluate(() => (globalThis as unknown as { __clicks?: number }).__clicks),
      ).toBe(2);
      expect(r.notes.join(" ")).toMatch(/no page change after click/);
    });
  }, 30_000);

  it("adopts a popup the click opens and continues the flow there", async () => {
    const html = `<!DOCTYPE html><html><body>
      <button id="go">Apply</button>
      <script>
        document.getElementById('go').addEventListener('click', () => {
          window.open('https://forms.ats-example.com/apply/7');
        });
      </script></body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      await page.context().route("**/apply/7", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<html><body><form><label>Name<input name='name'/></label></form></body></html>",
        }),
      );
      const r = await performTransition(page, page.locator("#go"), {
        settleTimeoutMs: 5_000,
      });
      expect(r.landed).toBe(true);
      expect(r.adopted_popup).toBe(true);
      expect(r.url).toBe("https://forms.ats-example.com/apply/7");
      expect(r.page).not.toBe(page); // the flow continues on the popup
      expect(r.classification.page_class).toBe("form");
      await r.page.close().catch(() => undefined);
    });
  }, 30_000);

  it("adopts a popup that starts about:blank and navigates late", async () => {
    const html = `<!DOCTYPE html><html><body>
      <button id="go">Apply now</button>
      <script>
        document.getElementById('go').addEventListener('click', () => {
          const w = window.open('', '_blank');
          setTimeout(() => { if (w) w.location = 'https://forms.ats-example.com/apply/late'; }, 1200);
        });
      </script></body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      await page.context().route("**/apply/late", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<html><body><form><label>Email<input type='email' name='email'/></label></form></body></html>",
        }),
      );
      const r = await performTransition(page, page.locator("#go"), {
        settleTimeoutMs: 5_000,
      });
      expect(r.landed).toBe(true);
      expect(r.adopted_popup).toBe(true);
      expect(r.url).toMatch(/\/apply\/late/);
      expect(r.notes.join(" ")).toMatch(/settled off about:blank/);
      expect(r.classification.page_class).toBe("form");
      await r.page.close().catch(() => undefined);
    });
  }, 30_000);

  it("settleTimeoutMs 0 keeps synchronous fixtures synchronous (single check)", async () => {
    const html = `<!DOCTYPE html><html><body>
      <div id="stage"><button id="go">Next</button></div>
      <script>
        document.getElementById('go').addEventListener('click', () => {
          document.getElementById('stage').innerHTML = '<p>done</p>';
        });
      </script></body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const start = Date.now();
      const r = await performTransition(page, page.locator("#go"), {
        settleTimeoutMs: 0,
        retryOnUnchanged: false,
      });
      expect(r.landed).toBe(true);
      expect(Date.now() - start).toBeLessThan(5_000);
    });
  }, 30_000);
});

describe("classifyPage (UNIT_CONFIRMED)", () => {
  it("names each landing kind from its own signals", () => {
    const cases: Array<[string, string]> = [
      [
        "<html><head><title>Sign in</title></head><body><h1>Sign in to apply</h1><form action='/login'><input type='email' name='email'><input type='password' name='password'><button>Log in</button></form></body></html>",
        "auth",
      ],
      [
        "<html><body><h2>Thank you for applying!</h2></body></html>",
        "confirmation",
      ],
      [
        "<html><body><form><label>First Name<input name='first_name'/></label></form></body></html>",
        "form",
      ],
      [
        "<html><body><h1>Great role</h1><a href='#'>Apply now</a></body></html>",
        "posting",
      ],
      ["<html><body><p>nothing here</p></body></html>", "unknown"],
    ];
    for (const [html, expected] of cases) {
      expect(
        classifyPage({ html, url: "https://careers.acme-example.com/x" }).page_class,
        expected,
      ).toBe(expected);
    }
  });

  it("per-ATS confirmation markers widen the generic set", () => {
    const html = "<html><body><p>Your candidacy is now in our system.</p></body></html>";
    expect(
      classifyPage({ html, url: "https://x.example" }).page_class,
    ).toBe("unknown");
    expect(
      classifyPage({
        html,
        url: "https://x.example",
        confirmationMarkers: /candidacy is now in our system/i,
      }).page_class,
    ).toBe("confirmation");
  });
});
