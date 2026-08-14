import { describe, expect, it } from "vitest";
import {
  classifyPage,
  hasApplicationIdentityFields,
} from "../../src/ats/shared/pageClassify.js";
import { advancePastPosting } from "../../src/ats/shared/postingAdvance.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";

/**
 * The Microsoft eightfold failure (live 2026-08-14, run aef17b3e).
 *
 * The run landed on the JOB LISTING page. That page has inputs — the site's
 * own "Search by job title, ID, or keyword" and "City, state, or
 * country/region" boxes — so the field counter said 5 and the classifier
 * said "form". The planner then mapped the location SEARCH box to
 * address.country, typed "United States" into it, and burned 100 seconds
 * timing out, while a plain "Apply now" button sat unclicked on the page.
 *
 * The operator's read was the correct one: "im not on the application page
 * and since i can see clearly theres an apply button let me click that
 * first."
 */
describe("posting vs form discrimination (UNIT_CONFIRMED)", () => {
  const LISTING_WITH_SEARCH_CHROME = `<html><body>
    <h1>Software Engineer</h1>
    <input id="position-query-search-search" placeholder="Search by job title, ID, or keyword" />
    <input id="position-location-search-search" placeholder="City, state, or country/region" />
    <input type="checkbox" id="alerts" /><label for="alerts">Turn on job alerts for this search</label>
    <button>Apply now</button>
  </body></html>`;

  it("a listing page's search chrome is not an application form", () => {
    const c = classifyPage({
      html: LISTING_WITH_SEARCH_CHROME,
      url: "https://microsoft.eightfold.ai/careers?pid=197",
    });
    expect(c.page_class).toBe("posting");
    // The fields are still counted and reported — they exist, they are just
    // not an application.
    expect(c.field_count).toBeGreaterThan(0);
    expect(c.evidence).toMatch(/none of the .* ask who you are/);
  });

  it("a real form with an Apply button still classifies as a form", () => {
    // Many boards render the form and an "Apply" submit on the same page —
    // the identity fields are what settle it.
    const html = `<html><body>
      <form>
        <label>First Name<input name="first_name"/></label>
        <label>Email<input type="email" name="email"/></label>
      </form>
      <button>Apply</button>
    </body></html>`;
    expect(classifyPage({ html, url: "https://x.example" }).page_class).toBe("form");
  });

  it("a form with no Apply CTA is a form regardless of identity fields", () => {
    const html = `<html><body><form><label>Why us<input name="why"/></label></form></body></html>`;
    expect(classifyPage({ html, url: "https://x.example" }).page_class).toBe("form");
  });

  it("hasApplicationIdentityFields names the applicant questions only", () => {
    expect(
      hasApplicationIdentityFields([{ label: "Email", type: "email" }]),
    ).toBe(true);
    expect(
      hasApplicationIdentityFields([{ label: "First Name", type: "text" }]),
    ).toBe(true);
    expect(
      hasApplicationIdentityFields([
        { label: "Resume", name: "resume", type: "file" },
      ]),
    ).toBe(true);
    // A location SEARCH box is not identity — this is the exact field that
    // got mapped to address.country on the live listing page.
    expect(
      hasApplicationIdentityFields([
        { label: "City, state, or country/region", type: "text" },
      ]),
    ).toBe(false);
    expect(
      hasApplicationIdentityFields([
        { label: "Search by job title, ID, or keyword", type: "text" },
      ]),
    ).toBe(false);
  });
});

describe("advancePastPosting (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  it("clicks Apply on a posting and continues on the form it reveals", async () => {
    const html = `<!DOCTYPE html><html><body>
      <div id="stage">
        <h1>Software Engineer</h1>
        <input id="position-query-search-search" placeholder="Search by job title, ID, or keyword" />
        <button id="apply">Apply now</button>
      </div>
      <script>
        document.getElementById('apply').addEventListener('click', () => {
          document.getElementById('stage').innerHTML =
            '<form><label>First Name<input name="first_name"/></label>' +
            '<label>Email<input type="email" name="email"/></label></form>';
        });
      </script></body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const r = await advancePastPosting({
        page,
        html,
        url: page.url(),
        settleTimeoutMs: 5_000,
      });
      expect(r.advanced).toBe(true);
      expect(r.page_class).toBe("form");
      expect(r.hops).toBe(1);
      expect(r.html).toContain("first_name");
      expect(r.notes.join(" ")).toMatch(/landed on a posting/);
    });
  }, 45_000);

  it("does nothing when the landing is already a form", async () => {
    const html = `<html><body><form>
      <label>First Name<input name="first_name"/></label>
      <label>Email<input type="email" name="email"/></label>
    </form></body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const r = await advancePastPosting({ page, html, url: page.url() });
      expect(r.advanced).toBe(false);
      expect(r.hops).toBe(0);
      expect(r.page_class).toBe("form");
      expect(r.notes).toEqual([]);
    });
  }, 45_000);

  it("never mistakes a listing's \"Apply filters\" facet for the Apply button", async () => {
    const html = `<!DOCTYPE html><html><body>
      <input id="q" placeholder="Search by job title, ID, or keyword" />
      <button id="facets">Apply filters</button>
      <a href="https://forms.ats-example.com/careers/apply/42" id="real">Apply now</a>
      <script>
        document.getElementById('facets').addEventListener('click', () => {
          (globalThis).__facetsClicked = true;
        });
      </script></body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      await page.context().route("**/careers/apply/42", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<html><body><form><label>Email<input type='email' name='email'/></label></form></body></html>",
        }),
      );
      const r = await advancePastPosting({
        page,
        html,
        url: page.url(),
        settleTimeoutMs: 5_000,
      });
      expect(
        await page.evaluate(
          () => (globalThis as unknown as { __facetsClicked?: boolean }).__facetsClicked,
        ),
      ).toBeUndefined();
      expect(r.page_class).toBe("form");
    });
  }, 45_000);

  it("reports honestly when a posting has no Apply control at all", async () => {
    const html = `<html><body>
      <input id="q" placeholder="Search by job title, ID, or keyword" />
      <p>To apply, email us.</p>
      <a>Apply</a>
    </body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      // The bare <a>Apply</a> is clickable but inert; the advance must not
      // claim success, and the caller refuses rather than filling the page.
      const r = await advancePastPosting({
        page,
        html,
        url: page.url(),
        settleTimeoutMs: 600,
      });
      expect(r.advanced).toBe(false);
      expect(r.page_class).toBe("posting");
    });
  }, 45_000);
});
