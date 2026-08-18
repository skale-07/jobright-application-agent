import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import {
  redactEmailForArtifact,
  triageInsiderEmails,
} from "../../src/contacts/insiderTriage.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";

/**
 * Insider Connection email triage (operator directive 2026-08-18), proven
 * on a fixture that replicates their annotated screenshots: three panels
 * (school / beyond / previous-company), View expanders, per-person email
 * icons, found/not-found popups, and the "Connect Via Email" modal with a
 * Start Email button that records if it is EVER clicked.
 */
const FIXTURE = fs.readFileSync(
  path.join(process.cwd(), "tests", "fixtures", "jobright", "insider-connection.html"),
  "utf8",
);

describe("insider email triage (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  it(
    "walks school+beyond, scrapes found emails only, skips not-found, never touches previous-company or Start Email",
    async () => {
      await withFixtureHtmlPage(FIXTURE, async (page) => {
        const report = await triageInsiderEmails(page, {
          popupTimeoutMs: 3_000,
          excludeEmails: ["operator.self@example.com"],
        });

        // Alex + Claire share one address (dedup); Runze from school.
        expect(report.emails.sort()).toEqual([
          "ayang@jumptrading.com",
          "rtang@jumptrading.com",
        ]);
        // 4 people across the two allowed panels; Rohit had no contact info.
        expect(report.people_checked).toBe(4);
        expect(report.not_found).toBe(1);
        expect(report.skipped_reason).toBeNull();

        // ONLY the email is scraped — the drafted subject/body and the
        // operator's own address in the body never surface anywhere.
        const dump = JSON.stringify(report);
        expect(dump).not.toContain("Seeking Your Advice");
        expect(dump).not.toContain("operator.self@example.com");

        const state = await page.evaluate<{
          startEmail: unknown;
          prevViewed: unknown;
          prevLookup: unknown;
        }>(`({
          startEmail: window.__startEmailClicked,
          prevViewed: window.__prevCompanyViewed,
          prevLookup: window.__prevCompanyLookup,
        })`);
        // The send button is never clicked...
        expect(state.startEmail).toBe(false);
        // ...and the previous-company panel is never opened or looked up.
        expect(state.prevViewed).toBeUndefined();
        expect(state.prevLookup).toBeUndefined();
      });
    },
    60_000,
  );

  it("a job with no insider panels skips cleanly", async () => {
    await withFixtureHtmlPage(
      "<html><body><h1>Some Job</h1><p>No insider connection area.</p></body></html>",
      async (page) => {
        const report = await triageInsiderEmails(page, { popupTimeoutMs: 1_000 });
        expect(report.emails).toEqual([]);
        expect(report.people_checked).toBe(0);
        expect(report.skipped_reason).toMatch(/triage skipped/);
      },
    );
  }, 45_000);

  it("a leftover Contact Info Found toast does not steal later lookups", async () => {
    const sticky = fs.readFileSync(
      path.join(
        process.cwd(),
        "tests",
        "fixtures",
        "jobright",
        "insider-connection-sticky-found.html",
      ),
      "utf8",
    );
    await withFixtureHtmlPage(sticky, async (page) => {
      const report = await triageInsiderEmails(page, {
        popupTimeoutMs: 4_000,
      });
      expect(report.emails.sort()).toEqual([
        "ayang@jumptrading.com",
        "cbao@jumptrading.com",
        "rtang@jumptrading.com",
      ]);
      expect(report.people_checked).toBe(3);
      expect(report.per_person.every((p) => p.outcome === "email_found")).toBe(
        true,
      );
    });
  }, 60_000);

  it("the people cap bounds lookups", async () => {
    await withFixtureHtmlPage(FIXTURE, async (page) => {
      const report = await triageInsiderEmails(page, {
        maxPeople: 1,
        popupTimeoutMs: 3_000,
      });
      expect(report.people_checked).toBe(1);
      expect(report.notes.join(" ")).toMatch(/1-person cap/);
    });
  }, 60_000);

  it("artifact redaction keeps only first char + domain", () => {
    expect(redactEmailForArtifact("ayang@jumptrading.com")).toBe(
      "a***@jumptrading.com",
    );
    expect(redactEmailForArtifact("nonsense")).toBe("***");
  });
});
