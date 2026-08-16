import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEmployerSandbox, type SandboxHandle } from "../../src/sandbox/server.js";
import {
  llmTraceEvent,
  postSandboxTrace,
  sandboxOriginFromUrl,
} from "../../src/sandbox/trace.js";
import { classifyPage } from "../../src/ats/shared/pageClassify.js";
import { discoverFieldsFromHtml } from "../../src/applications/fieldDiscovery.js";
import { validateGenericApplicationUrl } from "../../src/ats/generic/urlValidation.js";
import { detectAtsFromUrl } from "../../src/ats/shared/urlValidationDispatch.js";
import { isRecognizedAtsAuthHost } from "../../src/verification/portalAuth.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";
import { resetConfigCache } from "../../src/config/index.js";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * The employer sandbox (operator directive 2026-08-15): a fake employer on
 * the operator's own machine, driven by the REAL pipeline with their real
 * presets. These tests prove the sandbox itself behaves like the employer
 * it imitates — pages classify the way live pages do, the auth wall holds,
 * accounts round-trip — so a sandbox pass/fail on the operator's desktop
 * measures Dispatch, not the rig.
 */
describe("employer sandbox (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");
  let sandbox: SandboxHandle;
  const outDir = path.join(os.tmpdir(), `sandbox-out-${randomUUID()}`);

  beforeAll(async () => {
    sandbox = await startEmployerSandbox({ port: 0, quiet: true, outDir });
  });
  afterAll(async () => {
    await sandbox.close();
  });

  const get = async (p: string): Promise<{ status: number; html: string }> => {
    const res = await fetch(`${sandbox.url}${p}`, { redirect: "manual" });
    return { status: res.status, html: await res.text() };
  };

  it("the /portal posting classifies as a POSTING despite its search chrome", async () => {
    const { html } = await get("/portal");
    const c = classifyPage({ html, url: `${sandbox.url}/portal` });
    expect(c.page_class).toBe("posting");
    // Nested <button> inside <a> does not navigate; Apply must be the link.
    expect(html).toMatch(/<a href="\/portal\/auth">Apply<\/a>/);
  });

  it("the /gauntlet page classifies as a FORM with the wild questions discoverable", async () => {
    const { html } = await get("/gauntlet");
    const c = classifyPage({ html, url: `${sandbox.url}/gauntlet` });
    expect(c.page_class).toBe("form");
    const labels = discoverFieldsFromHtml(html).map((f) => f.label);
    // The artifact-sourced questions are present in BOTH classes.
    expect(labels.join(" | ")).toMatch(/university organizations/);
    expect(labels.join(" | ")).toMatch(/Where is your hometown/);
    // Closed questions carry their real option lists in the HTML.
    const gpa = discoverFieldsFromHtml(html).find((f) =>
      f.label.includes("cumulative GPA"),
    );
    expect(gpa?.options).toContain("3.7 or Higher");
  });

  it("the auth wall classifies as AUTH and guards the form", async () => {
    const { html } = await get("/portal/auth");
    const c = classifyPage({ html, url: `${sandbox.url}/portal/auth` });
    expect(c.page_class).toBe("auth");
    // Unauthenticated form access bounces back to the wall.
    const bounced = await get("/portal/form");
    expect(bounced.status).toBe(302);
  });

  it("create account → session cookie → form; wrong password refused", async () => {
    const create = await fetch(`${sandbox.url}/portal/create-account`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: "candidate@fixture.test",
        password: "hunter2hunter2",
        verifyPassword: "hunter2hunter2",
      }),
    });
    expect(create.status).toBe(302);
    const cookie = create.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/sandbox_sid=/);
    expect(sandbox.accountEmails()).toContain("candidate@fixture.test");

    const form = await fetch(`${sandbox.url}/portal/form`, {
      headers: { cookie: cookie.split(";")[0]! },
    });
    expect(await form.text()).toMatch(/Application — AI Engineer Intern/);

    const bad = await fetch(`${sandbox.url}/portal/sign-in`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: "candidate@fixture.test",
        password: "wrong",
      }),
    });
    expect(bad.status).toBe(401);
  });

  it("a submitted application lands on a real confirmation page", async () => {
    const res = await fetch(`${sandbox.url}/gauntlet/submit`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ first_name: "Ada", q_appliance: "Other" }),
    });
    const html = await res.text();
    // The generic confirmation markers must match — this is what lets the
    // submit-verification loop complete locally.
    expect(
      classifyPage({ html, url: `${sandbox.url}/gauntlet/submit` }).page_class,
    ).toBe("confirmation");
  });

  it("POST /trace accepts plan lines (the ats:fill → sandbox terminal channel)", async () => {
    const res = await fetch(`${sandbox.url}/trace`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "plan",
        lines: ["FILL COBOL → No  [Predicted from operator context: no COBOL in about-me]"],
      }),
    });
    expect(res.status).toBe(204);
    const llm = llmTraceEvent({
      surface: "predict",
      system: "sys",
      user: { questions: [{ label: "spirit animal" }] },
      response: '{"predictions":[]}',
    });
    expect(llm.kind).toBe("llm predict");
    expect(llm.lines.join("\n")).toMatch(/request\.user/);
    expect(llm.lines.join("\n")).toMatch(/spirit animal/);
    expect(llm.lines.join("\n")).toMatch(/response/);
    expect(sandboxOriginFromUrl(`${sandbox.url}/gauntlet`)).toBe(sandbox.url);
    expect(sandboxOriginFromUrl("https://boards.greenhouse.io/x")).toBeNull();
    await expect(
      postSandboxTrace(`${sandbox.url}/gauntlet`, {
        kind: "plan",
        lines: ["ok"],
      }),
    ).resolves.toBeUndefined();
  });
});

describe("loopback allowances (UNIT_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  it("the generic adapter claims loopback URLs (the sandbox is drivable)", () => {
    const v = validateGenericApplicationUrl("http://localhost:4599/gauntlet");
    expect(v.passed).toBe(true);
    expect(v.warnings.join(" ")).toMatch(/loopback/);
    expect(detectAtsFromUrl("http://localhost:4599/gauntlet").ats).toBe("generic");
    expect(detectAtsFromUrl("http://127.0.0.1:4599/portal").ats).toBe("generic");
  });

  it("NON-loopback http is refused exactly as before", () => {
    expect(validateGenericApplicationUrl("http://employer.example.com/apply").passed).toBe(
      false,
    );
    // A LAN address is not loopback — someone else's machine stays https-only.
    expect(validateGenericApplicationUrl("http://192.168.1.20/apply").passed).toBe(false);
  });

  it("portal auth recognizes loopback ONLY with standing credentials set", () => {
    process.env.PORTAL_LOGIN_EMAIL = "candidate@fixture.test";
    process.env.PORTAL_LOGIN_PASSWORD = "hunter2hunter2";
    resetConfigCache();
    try {
      expect(isRecognizedAtsAuthHost("http://localhost:4599/portal/auth")).toBe(true);
      expect(isRecognizedAtsAuthHost("http://192.168.1.20/portal")).toBe(false);
    } finally {
      delete process.env.PORTAL_LOGIN_EMAIL;
      delete process.env.PORTAL_LOGIN_PASSWORD;
      resetConfigCache();
    }
  });
});
