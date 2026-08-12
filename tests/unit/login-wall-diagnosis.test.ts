import { describe, expect, it } from "vitest";
import {
  diagnoseLoginWall,
  summarizeLoginWall,
} from "../../src/verification/loginWallDiagnosis.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";

/**
 * Login-wall diagnosis (operator request 2026-08-12: "add more detailed
 * logging/detection so you and I can break down what's really happening
 * when it hits a login wall"). Zero-mutation reads only — every case here
 * asserts the SHAPE the flow branches on, because that shape is what
 * decides sign-in vs. escalate-to-create vs. park.
 */
describe("login wall diagnosis (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  it("classifies a plain sign-in form, and finds the create-account route", async () => {
    // Shaped after the live Amazon wall (passport.amazon.jobs).
    const html = `<!DOCTYPE html><html><body>
      <h1>Sign in</h1>
      <input type="email" name="email" />
      <input type="password" name="password" />
      <button>Sign in</button>
      <a href="/create">Create an Amazon.jobs account</a>
    </body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const d = await diagnoseLoginWall(page);
      expect(d.classification).toBe("sign_in_form");
      expect(d.fields).toMatchObject({
        email: true,
        password: true,
        confirmPassword: false,
      });
      expect(d.submitControls).toContain("Sign in");
      expect(d.createAccountRoute).toMatch(/Create an Amazon\.jobs account/);
      expect(d.errorText).toBeNull();
      expect(summarizeLoginWall(d)).toMatch(/sign_in_form/);
    });
  }, 30_000);

  it("classifies a create form by its confirm-password field", async () => {
    const html = `<!DOCTYPE html><html><body>
      <input type="email" name="email" />
      <input type="password" name="password" />
      <input type="password" name="confirmPassword" />
      <button>Create Account</button>
    </body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const d = await diagnoseLoginWall(page);
      expect(d.classification).toBe("create_account_form");
      expect(d.fields.confirmPassword).toBe(true);
    });
  }, 30_000);

  it("classifies a rejected credential — the ONLY trigger for create escalation", async () => {
    const html = `<!DOCTYPE html><html><body>
      <p role="alert">Your email or password is incorrect. Please try again.</p>
      <input type="email" name="email" />
      <input type="password" name="password" />
      <button>Sign in</button>
      <a href="/register">Create an account</a>
    </body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const d = await diagnoseLoginWall(page);
      expect(d.classification).toBe("credentials_rejected");
      expect(d.errorText).toMatch(/incorrect/i);
      expect(d.createAccountRoute).toBeTruthy();
    });
  }, 30_000);

  it("classifies a federated-only wall (no password field to fill)", async () => {
    const html = `<!DOCTYPE html><html><body>
      <button>Continue with Google</button>
      <button>Sign in with Apple</button>
    </body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const d = await diagnoseLoginWall(page);
      expect(d.classification).toBe("federated_only");
      expect(d.federatedProviders.length).toBeGreaterThan(0);
      // A federated button is never mistaken for a create-account route.
      expect(d.createAccountRoute).toBeNull();
    });
  }, 30_000);

  it("reports no_form_found on a page that is not an auth wall at all", async () => {
    await withFixtureHtmlPage(
      "<html><body><h1>Job description</h1><p>We are hiring.</p></body></html>",
      async (page) => {
        const d = await diagnoseLoginWall(page);
        expect(d.classification).toBe("no_form_found");
        expect(d.fields.password).toBe(false);
      },
    );
  }, 30_000);

  it("summary never leaks a typed password (it only reads names and errors)", async () => {
    const html = `<!DOCTYPE html><html><body>
      <input type="email" name="email" value="c@example.com" />
      <input type="password" name="password" value="hunter2-secret" />
      <button>Sign in</button>
    </body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const summary = summarizeLoginWall(await diagnoseLoginWall(page));
      expect(summary).not.toContain("hunter2-secret");
    });
  }, 30_000);
});
