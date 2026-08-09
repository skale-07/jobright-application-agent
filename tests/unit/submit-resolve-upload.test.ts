import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import {
  inventorySubmitCandidates,
  resolveSubmitControl,
} from "../../src/ats/shared/submitControl.js";
import {
  detectUploadCommit,
  resolveResumeFileInput,
} from "../../src/ats/shared/uploadResolve.js";
import { ashbySelectorsV1 } from "../../src/ats/ashby/selectors.js";
import { ashbyUploadFile } from "../../src/ats/ashby/fill.js";
import {
  applyFixtureFillEnv,
  applySafeFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";

// The one PDF check:secrets allowlists — never add new PDFs.
const SAMPLE_RESUME = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "ats",
  "greenhouse",
  "sample-resume.pdf",
);
const RESUME_SIZE = fs.statSync(SAMPLE_RESUME).size;

/**
 * The Netic failure class: live Ashby submit CTAs that a naïve
 * `button[type='submit']` one-shot query cannot see, and resume uploads
 * that flake on late-mounting/replaced file inputs. All FIXTURE_CONFIRMED
 * against synthetic DOMs shaped like the observed failure modes.
 */
describe("shared submit-control cascade (FIXTURE_CONFIRMED)", () => {
  const cascade = ashbySelectorsV1.submitCascade;

  it(
    "resolves a type=button 'Submit application' CTA inside the form (role-name tier)",
    async () => {
      const html = `
        <form>
          <input name="_systemfield_name" />
          <button type="button">Submit application</button>
        </form>`;
      await withFixtureHtmlPage(html, async (page) => {
        const r = await resolveSubmitControl(page, cascade);
        expect(r.found).toBe(true);
        if (r.found) expect(r.via).toBe("role-name");
      });
    },
    30_000,
  );

  it(
    "resolves a custom footer CTA rendered OUTSIDE the form (page-wide name fallback)",
    async () => {
      const html = `
        <form><input name="_systemfield_name" /></form>
        <div class="react-footer"><button type="button">Submit application</button></div>`;
      await withFixtureHtmlPage(html, async (page) => {
        const r = await resolveSubmitControl(page, cascade);
        expect(r.found).toBe(true);
        if (r.found) expect(r.via).toBe("page-role-name");
      });
    },
    30_000,
  );

  it(
    "classic unnamed button[type=submit] still resolves via the CSS tier",
    async () => {
      const html = `
        <form>
          <input name="_systemfield_name" />
          <button type="submit"></button>
        </form>`;
      await withFixtureHtmlPage(html, async (page) => {
        const r = await resolveSubmitControl(page, cascade);
        expect(r.found).toBe(true);
        if (r.found) expect(r.via).toBe("css");
      });
    },
    30_000,
  );

  it(
    "refuses a wizard: a lone 'Next' type=submit is never the submit control, and the miss carries an inventory",
    async () => {
      const html = `
        <form>
          <input name="_systemfield_name" />
          <button type="submit">Next</button>
          <button type="button">Back</button>
        </form>`;
      await withFixtureHtmlPage(html, async (page) => {
        const r = await resolveSubmitControl(page, cascade);
        expect(r.found).toBe(false);
        if (!r.found) {
          expect(r.notes.some((n) => /excluded name/.test(n))).toBe(true);
          expect(r.inventory.map((c) => c.text)).toContain("Next");
        }
      });
    },
    30_000,
  );

  it(
    "inventory captures tag/type/text/disabled for evidence",
    async () => {
      const html = `
        <form>
          <button type="button" disabled>Continue</button>
          <div role="button" aria-label="Close dialog">×</div>
        </form>`;
      await withFixtureHtmlPage(html, async (page) => {
        const inv = await inventorySubmitCandidates(page, "form");
        expect(inv.length).toBeGreaterThanOrEqual(2);
        const cont = inv.find((c) => c.text === "Continue");
        expect(cont?.disabled).toBe(true);
        expect(inv.some((c) => c.aria_label === "Close dialog")).toBe(true);
      });
    },
    30_000,
  );
});

describe("shared resume-upload resolve + commit detection (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  beforeEach(() => {
    applySafeFillEnv();
  });

  it(
    "keyword fallback finds a renamed resume input; lone-input fallback takes the only file input",
    async () => {
      await withFixtureHtmlPage(
        `<form><input type="file" name="applicant_resume_upload" /><input type="file" name="cover" /></form>`,
        async (page) => {
          const r = await resolveResumeFileInput(page, {
            css: ashbySelectorsV1.resume,
            retryAfterMs: 0,
          });
          expect(r.found).toBe(true);
          if (r.found) expect(r.via).toBe("keyword");
        },
      );
      await withFixtureHtmlPage(
        `<form><input type="file" name="custom_attachment" /></form>`,
        async (page) => {
          const r = await resolveResumeFileInput(page, {
            css: ashbySelectorsV1.resume,
            retryAfterMs: 0,
          });
          expect(r.found).toBe(true);
          if (r.found) expect(r.via).toBe("lone-input");
        },
      );
    },
    30_000,
  );

  it(
    "a dropzone that unmounts the input and shows a filename chip verifies as committed",
    async () => {
      const html = `
        <form>
          <input id="up" type="file" name="_systemfield_resume" />
          <div id="chip"></div>
        </form>
        <script>
          document.getElementById("up").addEventListener("change", (e) => {
            document.getElementById("chip").textContent = e.target.files[0].name;
            e.target.remove();
          });
        </script>`;
      await withFixtureHtmlPage(html, async (page) => {
        const input = page.locator("#up");
        await input.setInputFiles(SAMPLE_RESUME);
        const commit = await detectUploadCommit(page, input, {
          filename: "sample-resume.pdf",
          sizeBytes: RESUME_SIZE,
        });
        expect(commit.verified).toBe(true);
        expect(commit.evidence).toMatch(/chip=true/);
      });
    },
    30_000,
  );

  it(
    "ashbyUploadFile verifies through the chip path and reports the resolve route",
    async () => {
      applyFixtureFillEnv();
      const html = `
        <form>
          <input id="up" type="file" name="_systemfield_resume" />
          <div id="chip"></div>
        </form>
        <script>
          document.getElementById("up").addEventListener("change", (e) => {
            document.getElementById("chip").textContent = e.target.files[0].name;
            e.target.remove();
          });
        </script>`;
      await withFixtureHtmlPage(html, async (page) => {
        const upload = await ashbyUploadFile(page, "resume", SAMPLE_RESUME);
        expect(upload.verified).toBe(true);
        expect(upload.evidence).toMatch(/resolved via primary/);
      });
    },
    30_000,
  );

  it(
    "a page with no file input at all fails with a file-input inventory in the evidence",
    async () => {
      applyFixtureFillEnv();
      await withFixtureHtmlPage(
        `<form><input name="_systemfield_name" /></form>`,
        async (page) => {
          const upload = await ashbyUploadFile(page, "resume", SAMPLE_RESUME);
          expect(upload.verified).toBe(false);
          expect(upload.evidence).toMatch(/resume file input not found/);
          expect(upload.evidence).toMatch(/inventory/);
        },
      );
    },
    30_000,
  );
});
