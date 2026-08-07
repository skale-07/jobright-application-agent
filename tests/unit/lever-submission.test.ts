import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import {
  detectSubmissionUncertainty,
  extractApplicationIdentifier,
  leverSubmit,
  leverVerifySubmission,
  SubmissionUncertainError,
} from "../../src/ats/lever/submission.js";
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

const APPLY_URL =
  "https://jobs.lever.co/acme/a1b2c3d4-e5f6-7890-abcd-ef1234567890/apply";
const THANKS_URL =
  "https://jobs.lever.co/acme/a1b2c3d4-e5f6-7890-abcd-ef1234567890/thanks";

function scratchScreenshotPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lever-submit-test-"));
  return path.join(dir, "receipt.png");
}

describe("Lever submission (M3)", () => {
  useIsolatedFillEnv("safe");

  beforeEach(() => {
    applySafeFillEnv();
  });

  describe("detectSubmissionUncertainty (UNIT_CONFIRMED)", () => {
    it("confirms on confirmation markers", () => {
      expect(
        detectSubmissionUncertainty(fixtureHtml("lever-confirmation"), APPLY_URL),
      ).toBe("confirmed");
    });

    it("confirms on a /thanks URL even without markers", () => {
      expect(
        detectSubmissionUncertainty("<html><body></body></html>", THANKS_URL),
      ).toBe("confirmed");
    });

    it("classifies the application form as still_on_form", () => {
      expect(detectSubmissionUncertainty(fixtureHtml("lever"), APPLY_URL)).toBe(
        "still_on_form",
      );
    });

    it("classifies a blank page as unknown", () => {
      expect(
        detectSubmissionUncertainty("<html><body></body></html>", APPLY_URL),
      ).toBe("unknown");
    });

    it("extracts the confirmation identifier", () => {
      expect(
        extractApplicationIdentifier(fixtureHtml("lever-confirmation")),
      ).toBe("LV-9207-CONF");
    });
  });

  describe("guard refusal (UNIT_CONFIRMED)", () => {
    it("refuses with all flags off, before any page interaction", async () => {
      await expect(leverSubmit(null as unknown as Page)).rejects.toThrow(
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
        await expect(leverSubmit(null as unknown as Page)).rejects.toThrow(
          /SUBMIT_ENABLED=false/,
        );
      } finally {
        applySafeFillEnv();
      }
    });

    it("refuses under DRY_RUN=true even with both enables", async () => {
      applyControlledFillEnv({
        FORM_FILL_ENABLED: "true",
        DRY_RUN: "true",
        SUBMIT_ENABLED: "true",
      });
      try {
        await expect(leverSubmit(null as unknown as Page)).rejects.toThrow(
          /DRY_RUN=true/,
        );
      } finally {
        applySafeFillEnv();
      }
    });
  });

  describe("fixture submit flow (FIXTURE_CONFIRMED)", () => {
    it(
      "clicks submit, reaches the confirmation panel, and returns a receipt",
      async () => {
        applyControlledFillEnv({
          FORM_FILL_ENABLED: "true",
          DRY_RUN: "false",
          SUBMIT_ENABLED: "true",
        });
        const screenshotPath = scratchScreenshotPath();
        try {
          await withFixtureHtmlPage(
            fixtureHtml("lever-submitflow"),
            async (page) => {
              const attempt = await leverSubmit(page);
              expect(attempt.clicked).toBe(true);

              const receipt = await leverVerifySubmission(page, {
                screenshotPath,
                timeoutMs: 5_000,
              });
              expect(receipt.submitted).toBe(true);
              expect(receipt.application_identifier).toBe("LV-9207-CONF");
              expect(receipt.confirmation_text).toMatch(
                /application submitted/i,
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
      "throws SubmissionUncertainError when the page stays on the form, with screenshot evidence",
      async () => {
        const screenshotPath = scratchScreenshotPath();
        await withFixtureHtmlPage(fixtureHtml("lever"), async (page) => {
          // verifySubmission is deliberately not flag-gated (read-only).
          await expect(
            leverVerifySubmission(page, {
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
