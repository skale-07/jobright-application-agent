import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import {
  ashbySubmit,
  ashbyVerifySubmission,
  detectSubmissionUncertainty,
  extractApplicationIdentifier,
  SubmissionUncertainError,
} from "../../src/ats/ashby/submission.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import {
  applyControlledFillEnv,
  applySafeFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";

const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures", "ats");

function fixtureHtml(name: string): string {
  return fs.readFileSync(
    path.join(FIXTURE_DIR, name, "dom.sanitized.html"),
    "utf8",
  );
}

// Ashby never navigates on submit — the application URL is also the
// confirmation URL.
const APPLICATION_URL =
  "https://jobs.ashbyhq.com/acme/9b1e0c2a-1234-4abc-8def-1234567890ab/application";

function scratchScreenshotPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ashby-submit-test-"));
  return path.join(dir, "receipt.png");
}

describe("Ashby submission (M6)", () => {
  useIsolatedFillEnv("safe");

  beforeEach(() => {
    applySafeFillEnv();
  });

  describe("detectSubmissionUncertainty (UNIT_CONFIRMED)", () => {
    it("confirms on the in-page success panel with an unchanged URL", () => {
      expect(
        detectSubmissionUncertainty(
          fixtureHtml("ashby-confirmation"),
          APPLICATION_URL,
        ),
      ).toBe("confirmed");
    });

    it("classifies the application form as still_on_form", () => {
      expect(
        detectSubmissionUncertainty(fixtureHtml("ashby"), APPLICATION_URL),
      ).toBe("still_on_form");
    });

    it("classifies a blank page as unknown", () => {
      expect(
        detectSubmissionUncertainty(
          "<html><body></body></html>",
          APPLICATION_URL,
        ),
      ).toBe("unknown");
    });

    it("extracts the confirmation identifier", () => {
      expect(
        extractApplicationIdentifier(fixtureHtml("ashby-confirmation")),
      ).toBe("AB-3315-CONF");
    });
  });

  describe("guard refusal (UNIT_CONFIRMED)", () => {
    it("refuses with all flags off, before any page interaction", async () => {
      await expect(ashbySubmit(null as unknown as Page)).rejects.toThrow(
        /FORM_FILL_ENABLED=false/,
      );
    });

    it("refuses with fill enabled but SUBMIT_ENABLED=false", async () => {
      applyControlledFillEnv({
        FORM_FILL_ENABLED: "true",
        DRY_RUN: "false",
        SUBMIT_ENABLED: "false",
      });
      try {
        await expect(ashbySubmit(null as unknown as Page)).rejects.toThrow(
          /SUBMIT_ENABLED=false/,
        );
      } finally {
        applySafeFillEnv();
      }
    });
  });

  describe("fixture submit flow (FIXTURE_CONFIRMED)", () => {
    it(
      "clicks submit, sees the in-place success panel, and returns a receipt",
      async () => {
        applyControlledFillEnv({
          FORM_FILL_ENABLED: "true",
          DRY_RUN: "false",
          SUBMIT_ENABLED: "true",
        });
        const screenshotPath = scratchScreenshotPath();
        try {
          await withFixtureHtmlPage(
            fixtureHtml("ashby-submitflow"),
            async (page) => {
              const attempt = await ashbySubmit(page);
              expect(attempt.clicked).toBe(true);

              const receipt = await ashbyVerifySubmission(page, {
                screenshotPath,
                timeoutMs: 5_000,
              });
              expect(receipt.submitted).toBe(true);
              expect(receipt.application_identifier).toBe("AB-3315-CONF");
              expect(receipt.confirmation_text).toMatch(
                /application has been submitted/i,
              );
              expect(fs.existsSync(screenshotPath)).toBe(true);
            },
          );
        } finally {
          applySafeFillEnv();
        }
      },
      45_000,
    );

    it(
      "throws SubmissionUncertainError when the form never confirms, with screenshot evidence",
      async () => {
        const screenshotPath = scratchScreenshotPath();
        await withFixtureHtmlPage(fixtureHtml("ashby"), async (page) => {
          await expect(
            ashbyVerifySubmission(page, {
              screenshotPath,
              timeoutMs: 1_500,
            }),
          ).rejects.toThrow(SubmissionUncertainError);
          expect(fs.existsSync(screenshotPath)).toBe(true);
        });
      },
      45_000,
    );
  });
});
