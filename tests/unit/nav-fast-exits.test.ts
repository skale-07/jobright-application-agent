import { describe, expect, it } from "vitest";
import {
  clearJobRightInterstitial,
  detectClosedJobBanner,
  dismissJobRightModal,
} from "../../src/jobright/navigateToEmployer.js";
import { employerSiblingHosts } from "../../src/navigation/candidateLinks.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";

/**
 * Nav fast-exits from the 2026-08-12 live run + operator screenshots:
 * a CLOSED posting burned the full phase B + agent budget, JobRight's
 * "Did you apply?" modal sat over the page, and a legitimate
 * joinbytedance.com -> jobs.bytedance.com redirect was demoted as an
 * allowed_domains violation.
 */
describe("nav fast exits (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  it("detects JobRight's closed-posting banner", async () => {
    const closed = `<!DOCTYPE html><html><body>
      <div>100+ applicants</div><div>This job has closed.</div>
      <h1>Federal Data Scientist Intern 2027</h1></body></html>`;
    await withFixtureHtmlPage(closed, async (page) => {
      expect(await detectClosedJobBanner(page)).toBe(true);
    });
  }, 30_000);

  it("does NOT fire on an open posting (no false park)", async () => {
    const open = `<!DOCTYPE html><html><body>
      <div>Be an early applicant</div><button>Apply with Autofill</button>
      <p>This job is a great match. Closed captioning experience a plus.</p>
      </body></html>`;
    await withFixtureHtmlPage(open, async (page) => {
      expect(await detectClosedJobBanner(page)).toBe(false);
    });
  }, 30_000);

  it("closes the 'Did you apply?' modal via its X — never an answer button", async () => {
    const modal = `<!DOCTYPE html><html><body>
      <div role="dialog">
        <button aria-label="Close">x</button>
        <h2>Did you apply ?</h2>
        <button id="yes">Yes, I applied!</button>
        <button id="no">No, I didn't apply</button>
      </div>
      <script>
        document.querySelector('[aria-label="Close"]').addEventListener('click', () => {
          document.querySelector('[role=dialog]').remove();
          window.__closed = true;
        });
        for (const id of ['yes','no']) {
          document.getElementById(id).addEventListener('click', () => { window.__answered = id; });
        }
      </script></body></html>`;
    await withFixtureHtmlPage(modal, async (page) => {
      expect(await dismissJobRightModal(page)).toBe(true);
      expect(await page.evaluate(() => (globalThis as unknown as { __closed?: boolean }).__closed)).toBe(true);
      // The operator's application state is never asserted on their behalf.
      expect(
        await page.evaluate(() => (globalThis as unknown as { __answered?: string }).__answered),
      ).toBeUndefined();
    });
  }, 30_000);

  it("no modal present ⇒ no-op, not an error", async () => {
    await withFixtureHtmlPage("<html><body><p>plain</p></body></html>", async (page) => {
      expect(await dismissJobRightModal(page)).toBe(false);
    });
  }, 30_000);

  it("interstitial: PROCEEDS through 'Apply Without Customizing' rather than closing it", async () => {
    // Operator screenshot 2026-08-12: JobRight offers to tailor the resume
    // first. Closing that dialog drops back to the job page with nothing
    // done; proceeding is the decision the operator already made by
    // queuing the application.
    const html = `<!DOCTYPE html><html><body>
      <div role="dialog">
        <button aria-label="Close">x</button>
        <h2>Customize your resume for this job?</h2>
        <button id="tailor">Customize with AI</button>
        <button id="plain">Apply Without Customizing</button>
      </div>
      <script>
        document.getElementById('plain').addEventListener('click', () => {
          (globalThis).__proceeded = true;
        });
        document.querySelector('[aria-label="Close"]').addEventListener('click', () => {
          (globalThis).__closed = true;
        });
        document.getElementById('tailor').addEventListener('click', () => {
          (globalThis).__tailored = true;
        });
      </script></body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const r = await clearJobRightInterstitial(page);
      expect(r.cleared).toBe("proceeded");
      expect(await page.evaluate(() => (globalThis as unknown as { __proceeded?: boolean }).__proceeded)).toBe(true);
      expect(await page.evaluate(() => (globalThis as unknown as { __closed?: boolean }).__closed)).toBeUndefined();
      // Never the paid/AI path — that spends the operator's credits.
      expect(await page.evaluate(() => (globalThis as unknown as { __tailored?: boolean }).__tailored)).toBeUndefined();
    });
  }, 30_000);

  it("interstitial: screenshot-shaped modal — text link, never Fix My Resume, never X", async () => {
    // Operator screenshot 2026-08-13: "Customize Your Resume in 10 seconds",
    // green "Fix My Resume Now", skip is a centered text link (no button role).
    const html = `<!DOCTYPE html><html><body>
      <div class="ant-modal" role="dialog">
        <button aria-label="Close">x</button>
        <h2>Customize Your Resume in 10 seconds</h2>
        <p>Your resume match score is low, and it's likely to be filtered out by ATS</p>
        <button id="fix">Fix My Resume Now</button>
        <div id="skip">Apply Without Customizing</div>
        <label><input type="checkbox"> Do not remind me again</label>
      </div>
      <script>
        document.getElementById('skip').addEventListener('click', () => {
          (globalThis).__proceeded = true;
        });
        document.querySelector('[aria-label="Close"]').addEventListener('click', () => {
          (globalThis).__closed = true;
        });
        document.getElementById('fix').addEventListener('click', () => {
          (globalThis).__tailored = true;
        });
      </script></body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const r = await clearJobRightInterstitial(page);
      expect(r.cleared).toBe("proceeded");
      expect(await page.evaluate(() => (globalThis as unknown as { __proceeded?: boolean }).__proceeded)).toBe(true);
      expect(await page.evaluate(() => (globalThis as unknown as { __closed?: boolean }).__closed)).toBeUndefined();
      expect(await page.evaluate(() => (globalThis as unknown as { __tailored?: boolean }).__tailored)).toBeUndefined();
    });
  }, 30_000);

  it("interstitial: falls back to the X when no proceed CTA exists", async () => {
    const html = `<!DOCTYPE html><html><body>
      <div role="dialog">
        <button aria-label="Close">x</button>
        <h2>Upgrade to Turbo</h2>
        <button id="buy">See plans</button>
      </div>
      <script>
        document.querySelector('[aria-label="Close"]').addEventListener('click', () => {
          document.querySelector('[role=dialog]').remove();
          (globalThis).__closed = true;
        });
        document.getElementById('buy').addEventListener('click', () => { (globalThis).__bought = true; });
      </script></body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const r = await clearJobRightInterstitial(page);
      expect(r.cleared).toBe("closed");
      expect(await page.evaluate(() => (globalThis as unknown as { __closed?: boolean }).__closed)).toBe(true);
      expect(await page.evaluate(() => (globalThis as unknown as { __bought?: boolean }).__bought)).toBeUndefined();
    });
  }, 30_000);

  it("interstitial: a clean page is a no-op with no note", async () => {
    await withFixtureHtmlPage("<html><body><p>job</p></body></html>", async (page) => {
      expect(await clearJobRightInterstitial(page)).toEqual({ cleared: null, note: null });
    });
  }, 30_000);

  it("employer sibling hosts cover the bytedance redirect, exclude socials", () => {
    const hosts = employerSiblingHosts(
      [
        "https://joinbytedance.com/careers/123",
        "https://www.linkedin.com/company/bytedance",
        "https://www.glassdoor.com/x",
      ],
      "ByteDance",
    );
    // jobs.bytedance.com ends with bytedance.com (company token) — allowed.
    expect(hosts).toContain("bytedance.com");
    expect(hosts).toContain("joinbytedance.com");
    expect(hosts.join(" ")).not.toMatch(/linkedin|glassdoor/);
  });

  it("company tokens too short or generic never widen the allowlist", () => {
    expect(employerSiblingHosts([], "Inc")).toEqual([]);
    expect(employerSiblingHosts([], null)).toEqual([]);
  });
});
