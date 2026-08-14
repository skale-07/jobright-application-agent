import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Page } from "playwright";
import {
  SubmissionUncertainError,
  detectVisibleValidationError,
} from "../../src/ats/shared/submissionUncertain.js";
import { greenhouseVerifySubmission } from "../../src/ats/greenhouse/submission.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import { runNavigation, type NavSession } from "../../src/navigation/runNavigation.js";
import {
  closeDatabase,
  migrate,
  openDatabase,
} from "../../src/storage/db/client.js";
import { createApplication } from "../../src/queue/stateMachine.js";
import { upsertJobByFingerprint } from "../../src/jobs/repository.js";
import {
  applyControlledFillEnv,
  applySafeFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";
import { resetConfigCache } from "../../src/config/index.js";

/**
 * The 2026-08-14 speed pass, measured against run 8bcff01c (~45–55s/app):
 *  1. inter-app jitter default cut from [15s,45s] to [2s,5s]
 *  2. one shared JobRight session across the armed loop (callerOwnedSession)
 *  3. submit confirmation fails FAST when the form shows a validation error
 *     instead of burning the full 15s window (12× in the live corpus).
 */
describe("speed pass 2026-08-14", () => {
  useIsolatedFillEnv("safe");

  describe("visible-validation-error detector (UNIT_CONFIRMED)", () => {
    it("matches the phrasings ATSes actually render", () => {
      for (const html of [
        "<div class='error'>This field is required</div>",
        "<p>Work Email is a required field</p>",
        "<span>Please fill in all required fields</span>",
        "<div role='alert'>Please correct the errors below</div>",
        "<div>There was a problem submitting your application</div>",
        "<div>We couldn't submit your application</div>",
      ]) {
        expect(detectVisibleValidationError(html)).not.toBeNull();
      }
    });

    it("never fires on prose that merely mentions errors or requirements", () => {
      for (const html of [
        "<p>You will own our error budgets and SLOs.</p>",
        "<p>A bachelor's degree is required for this role.</p>",
        "<p>Fill out the form below to apply.</p>",
        "<p>Required skills: TypeScript</p>",
      ]) {
        expect(detectVisibleValidationError(html)).toBeNull();
      }
    });
  });

  it("greenhouse verify fails FAST with the on-screen reason (FIXTURE_CONFIRMED)", async () => {
    const rejectedFormHtml = `<!DOCTYPE html><html><body>
      <form id="application_form" action="#">
        <div class="field-error">This field is required</div>
        <label>First Name<input name="first_name" /></label>
        <input type="submit" value="Submit Application" />
      </form></body></html>`;
    const shot = path.join(os.tmpdir(), `jaa-fastfail-${randomUUID()}.png`);
    await withFixtureHtmlPage(rejectedFormHtml, async (page) => {
      const start = Date.now();
      const err = await greenhouseVerifySubmission(page, {
        screenshotPath: shot,
        timeoutMs: 15_000,
      }).then(
        () => null,
        (e: unknown) => e,
      );
      const elapsed = Date.now() - start;
      expect(err).toBeInstanceOf(SubmissionUncertainError);
      const uncertain = err as SubmissionUncertainError;
      // The whole point: the reason is on screen, so we do not wait 15s.
      expect(elapsed).toBeLessThan(6_000);
      expect(uncertain.message).toMatch(/rejected by the form/);
      expect(uncertain.message).toMatch(/field is required/i);
      expect(uncertain.evidence["validation_error"]).toMatch(/field is required/i);
    });
    fs.rmSync(shot, { force: true });
  }, 30_000);

  it("a caller-owned session is never closed — only the run's page (FIXTURE_CONFIRMED)", async () => {
    const dbPath = path.join(os.tmpdir(), `jaa-navshare-${randomUUID()}.sqlite`);
    process.env.DATABASE_PATH = dbPath;
    resetConfigCache();
    const db = openDatabase(dbPath);
    migrate(db);
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    resetConfigCache();
    try {
      const jrId = `6a${randomUUID().replace(/-/g, "").slice(0, 22)}`;
      const job = upsertJobByFingerprint(db, {
        jobrightJobId: jrId,
        applicationUrl: `https://jobright.ai/jobs/info/${jrId}`,
        company: "Acme",
        role: "SWE",
      });
      const appId = createApplication(db, { jobId: job.id }).id;
      db.prepare(
        `UPDATE applications SET state = 'APPLICATION_OPENING' WHERE id = ?`,
      ).run(appId);

      let sessionClosed = 0;
      let pageClosed = false;
      await withFixtureHtmlPage("<html><body></body></html>", async (outer: Page) => {
        await outer.context().route("**/*", (route) =>
          route.fulfill({
            // Closed posting: the run ends fast and deterministically.
            body: "<html><body><div>This job has closed.</div></body></html>",
            contentType: "text/html",
          }),
        );
        outer.on("close", () => {
          pageClosed = true;
        });
        const session: NavSession = {
          open: async () => {
            throw new Error("caller-owned session must not be re-opened");
          },
          newPage: async () => outer,
          getContext: () => outer.context(),
          close: async () => {
            sessionClosed += 1;
          },
        };
        const report = await runNavigation({
          db,
          applicationId: appId,
          sessionOverride: session,
          callerOwnedSession: true,
          skipAuthLossCheck: true,
          agentPhaseOverride: false,
        });
        expect(report.wall).toBe("closed");
      });
      // The session survived; the tab it opened did not.
      expect(sessionClosed).toBe(0);
      expect(pageClosed).toBe(true);
    } finally {
      applySafeFillEnv();
      closeDatabase(db);
      for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        if (fs.existsSync(p)) fs.rmSync(p, { force: true });
      }
      resetConfigCache();
    }
  }, 45_000);

  it("the default inter-app delay is seconds, not tens of seconds (UNIT_CONFIRMED)", async () => {
    // Read the constant straight from the source — a regression to [15s,45s]
    // is a ~10× session slowdown and must not land silently.
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "src", "automation", "worker.ts"),
      "utf8",
    );
    const m = src.match(
      /DEFAULT_DELAY_MS:\s*\[number,\s*number\]\s*=\s*\[(\d[\d_]*),\s*(\d[\d_]*)\]/,
    );
    expect(m).not.toBeNull();
    const [min, max] = [Number(m![1]!.replace(/_/g, "")), Number(m![2]!.replace(/_/g, ""))];
    expect(min).toBeLessThanOrEqual(5_000);
    expect(max).toBeLessThanOrEqual(10_000);
  });
});
