import { describe, expect, it } from "vitest";
import { dismissPageObstructions } from "../../src/browser/obstructions.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";

/**
 * Popup/interstitial dismisser: overlays NOT associated with the
 * application (cookie banners, upsell modals) are cleared; anything with
 * progression/submission semantics is refused even inside a dialog.
 * FIXTURE_CONFIRMED against synthetic DOMs.
 */
describe("obstruction dismisser (FIXTURE_CONFIRMED)", () => {
  it(
    "dismisses a cookie banner and an upsell modal, leaving the page's Apply button intact",
    async () => {
      const html = `<html><body>
        <div id="cookie-banner" style="position:fixed;bottom:0">
          We use cookies.
          <button onclick="document.getElementById('cookie-banner').remove()">Accept all</button>
        </div>
        <div role="dialog" id="upsell" aria-modal="true">
          Upgrade to premium for more matches!
          <button aria-label="Close" onclick="document.getElementById('upsell').remove()">✕</button>
          <button>Upgrade now</button>
        </div>
        <button id="apply">Apply</button>
      </body></html>`;
      await withFixtureHtmlPage(html, async (page) => {
        const r = await dismissPageObstructions(page);
        expect(r.dismissed.length).toBe(2);
        expect(await page.locator("#cookie-banner").count()).toBe(0);
        expect(await page.locator("#upsell").count()).toBe(0);
        // The page's own Apply control is untouched and still there.
        expect(await page.locator("#apply").count()).toBe(1);
      });
    },
    45_000,
  );

  it(
    "never clicks progression/submission controls, even inside a dialog",
    async () => {
      // A modal that ONLY offers submit/continue-style actions must be
      // left alone — it might be part of the application itself.
      const html = `<html><body>
        <div role="dialog" id="appmodal" aria-modal="true">
          Ready to send your application?
          <button>Submit application</button>
          <button>Continue</button>
          <button>Sign in</button>
        </div>
      </body></html>`;
      await withFixtureHtmlPage(html, async (page) => {
        const r = await dismissPageObstructions(page);
        expect(r.dismissed).toEqual([]);
        expect(await page.locator("#appmodal").count()).toBe(1);
      });
    },
    45_000,
  );

  it(
    "caps dismissals — a popup farm cannot stall the flow",
    async () => {
      const modals = Array.from(
        { length: 6 },
        (_, i) =>
          `<div role="dialog" id="m${i}">Promo ${i}<button onclick="document.getElementById('m${i}').remove()">Got it</button></div>`,
      ).join("\n");
      await withFixtureHtmlPage(`<html><body>${modals}</body></html>`, async (page) => {
        const r = await dismissPageObstructions(page, { settleMs: 50 });
        expect(r.dismissed.length).toBe(3); // default cap
      });
    },
    45_000,
  );

  it(
    "a clean page returns fast with nothing dismissed",
    async () => {
      await withFixtureHtmlPage(
        `<html><body><form><input name="email"><button type="submit">Apply</button></form></body></html>`,
        async (page) => {
          const r = await dismissPageObstructions(page);
          expect(r.dismissed).toEqual([]);
          expect(r.notes).toEqual([]);
        },
      );
    },
    45_000,
  );
});
