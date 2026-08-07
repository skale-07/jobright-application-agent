import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runAtsLiveFill } from "../../src/applications/atsLiveFill.js";
import { ATS_BINDINGS } from "../../src/applications/atsBindings.js";
import { PlaywrightServiceSession } from "../../src/auth/serviceSession.js";
import { parsePublicProfile } from "../../src/candidate/publicProfile.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import { probeCdpEndpoint } from "../../src/navigation/runNavigation.js";
import {
  applySafeFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";

const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures", "ats");
const LEVER_URL =
  "https://jobs.lever.co/acme/a1b2c3d4-e5f6-7890-abcd-ef1234567890/apply";

describe("CDP session handoff (N6)", () => {
  useIsolatedFillEnv("safe");

  beforeEach(() => {
    applySafeFillEnv();
  });

  it("ServiceSession honors a per-instance cdpUrl override (UNIT_CONFIRMED)", () => {
    const session = new PlaywrightServiceSession({
      service: "jobright",
      mode: "CDP_ATTACH",
      cdpUrl: "http://127.0.0.1:9333",
    });
    // Constructor state only — no live CDP needed to verify the plumbing.
    expect(session.mode).toBe("CDP_ATTACH");
    expect(
      (session as unknown as { cdpUrlOverride: string }).cdpUrlOverride,
    ).toBe("http://127.0.0.1:9333");
  });

  it("probeCdpEndpoint answers false fast for an unreachable endpoint (UNIT_CONFIRMED)", async () => {
    const started = Date.now();
    expect(await probeCdpEndpoint("http://127.0.0.1:59999")).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it(
    "runAtsLiveFill runs plan_only on an injected page and never closes it (FIXTURE_CONFIRMED)",
    async () => {
      const leverHtml = fs.readFileSync(
        path.join(FIXTURE_DIR, "lever", "dom.sanitized.html"),
        "utf8",
      );
      await withFixtureHtmlPage("<html><body></body></html>", async (page) => {
        await page
          .context()
          .route("**/*", (route) =>
            route.fulfill({ body: leverHtml, contentType: "text/html" }),
          );
        const report = await runAtsLiveFill({
          binding: ATS_BINDINGS.lever,
          url: LEVER_URL,
          execute: false,
          profile: parsePublicProfile({
            legal_name: { first: "Ada", last: "Lovelace" },
            email: "ada@example.com",
          }),
          existingPage: page,
        });
        expect(report.mode).toBe("plan_only");
        expect(report.gate.ok).toBe(true);
        expect(report.notes.join(" ")).toMatch(/session: handoff/);
        // Caller still owns a usable page afterwards.
        expect(page.isClosed()).toBe(false);
        expect(await page.title()).toBeDefined();
      });
    },
    45_000,
  );
});
