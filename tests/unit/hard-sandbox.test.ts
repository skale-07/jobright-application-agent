import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEmployerSandbox, type SandboxHandle } from "../../src/sandbox/server.js";
import {
  deliverVerificationCode,
  generateVerificationCode,
} from "../../src/sandbox/email.js";
import { classifyPage } from "../../src/ats/shared/pageClassify.js";
import { discoverFieldsFromHtml } from "../../src/applications/fieldDiscovery.js";
import { verificationEvidencePresent } from "../../src/navigation/runNavigation.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";

/**
 * The HARD sandbox courses + the Resend verification wall (operator
 * directive 2026-08-16). Every obstacle re-creates a struggle from a live
 * artifact; these tests prove the RIG behaves like the pages it imitates,
 * so a pass/fail on the operator's desktop measures Dispatch, not the rig.
 */
describe("hard sandbox courses (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");
  let sandbox: SandboxHandle;
  const outDir = path.join(os.tmpdir(), `sandbox-hard-${randomUUID()}`);

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
  const post = async (
    p: string,
    body: Record<string, string>,
    cookie?: string,
  ): Promise<Response> =>
    fetch(`${sandbox.url}${p}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(cookie ? { cookie } : {}),
      },
      body: new URLSearchParams(body),
    });

  it("/navhard classifies as a POSTING despite decoys and cookie banner", async () => {
    const { html } = await get("/navhard");
    expect(classifyPage({ html, url: `${sandbox.url}/navhard` }).page_class).toBe(
      "posting",
    );
    // The decoys are present — the Apply matcher has something to get wrong.
    expect(html).toMatch(/Apply filters/);
    expect(html).toMatch(/How to apply/);
    expect(html).toMatch(/Accept Cookies/);
  });

  it("the lead-capture modal is a FORM whose identity fields the fill can plan", async () => {
    const { html } = await get("/navhard/started");
    // The operator's design point: this page needs FILL context (name,
    // email, phone), so it must classify as a form and its fields must be
    // discoverable — nav hands it to the fill machinery, no separate
    // demographic framework.
    expect(classifyPage({ html, url: `${sandbox.url}/navhard/started` }).page_class).toBe(
      "form",
    );
    const fields = discoverFieldsFromHtml(html);
    const labels = fields.map((f) => f.label);
    expect(labels).toContain("Legal First Name");
    expect(labels).toContain("Email Address");
    expect(labels).toContain("Primary Phone Number");
    const sms = fields.find((f) => f.name === "sms_consent");
    expect(sms?.type).toBe("radio");
    expect(sms?.label).toMatch(/text communications/i);
    expect(sms?.options).toEqual(["Yes", "No"]);
  });

  it("the lead-capture continue leads to the real form, then confirmation", async () => {
    const cont = await post("/navhard/continue", {
      first_name: "Ada",
      last_name: "Lovelace",
      email: "candidate@fixture.test",
      phone: "410-555-0100",
      sms_consent: "No",
    });
    expect(cont.status).toBe(302);
    expect(cont.headers.get("location")).toBe("/navhard/form");
    const { html } = await get("/navhard/form");
    expect(classifyPage({ html, url: `${sandbox.url}/navhard/form` }).page_class).toBe(
      "form",
    );
    const done = await post("/navhard/submit", { first_name: "Ada" });
    expect(
      classifyPage({ html: await done.text(), url: `${sandbox.url}/navhard/submit` })
        .page_class,
    ).toBe("confirmation");
  });

  it("/fillhard outer page has ZERO fields — the iframe hop is mandatory", async () => {
    const { html } = await get("/fillhard");
    expect(discoverFieldsFromHtml(html)).toHaveLength(0);
    expect(html).toMatch(/iframe src="\/fillhard\/embed"/);
  });

  it("/fillhard embed carries the wizard with the pre-filled WRONG email", async () => {
    const { html } = await get("/fillhard/embed");
    const fields = discoverFieldsFromHtml(html);
    const email = fields.find((f) => f.id === "email");
    expect(html).toMatch(/value="wrong\.person@example\.com"/);
    expect(email).toBeDefined();
    const labels = fields.map((f) => f.label);
    expect(labels).toContain("Which technology are you strongest in?");
    // Page 2 is display:none — planning those selects on step 1 made fill
    // timeout on hidden controls and blocked the Next walker.
    expect(labels).not.toContain(
      "Which development environment feels most like home?",
    );
  });
});

describe("portal email verification wall (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");
  let sandbox: SandboxHandle;

  beforeAll(async () => {
    sandbox = await startEmployerSandbox({
      port: 0,
      quiet: true,
      outDir: path.join(os.tmpdir(), `sandbox-verify-${randomUUID()}`),
    });
  });
  afterAll(async () => {
    await sandbox.close();
  });

  const createAccount = async (email: string): Promise<string> => {
    const res = await fetch(`${sandbox.url}/portal/create-account`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email,
        password: "hunter2hunter2",
        verifyPassword: "hunter2hunter2",
      }),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/portal/verify");
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  };

  it("account creation issues a RANDOM code and gates the form behind it", async () => {
    const cookie = await createAccount("verifyme@fixture.test");
    const code = sandbox.pendingCodeFor("verifyme@fixture.test");
    expect(code).toMatch(/^\d{6}$/);

    // The wall page: recognized by the SAME signals the live recovery uses.
    const wall = await fetch(`${sandbox.url}/portal/verify`, { headers: { cookie } });
    const wallHtml = await wall.text();
    expect(wallHtml).toMatch(/autocomplete="one-time-code"/);
    expect(wallHtml).toMatch(/data-automation-id="verifyButton"/);
    expect(verificationEvidencePresent(wallHtml)).toBe(true);
    expect(
      classifyPage({ html: wallHtml, url: `${sandbox.url}/portal/verify` }).page_class,
    ).toBe("auth");

    // The form is unreachable while unverified.
    const blocked = await fetch(`${sandbox.url}/portal/form`, {
      redirect: "manual",
      headers: { cookie },
    });
    expect(blocked.status).toBe(302);
    expect(blocked.headers.get("location")).toBe("/portal/verify");

    // Wrong code refused; right code verifies and unlocks the form.
    const bad = await fetch(`${sandbox.url}/portal/verify`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ code: "000000" === code ? "111111" : "000000" }),
    });
    expect(bad.status).toBe(401);
    const ok = await fetch(`${sandbox.url}/portal/verify`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ code: code! }),
    });
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe("/portal/form");
    const form = await fetch(`${sandbox.url}/portal/form`, { headers: { cookie } });
    expect(await form.text()).toMatch(/Application — AI Engineer Intern/);
  });

  it("signing in unverified re-issues a FRESH code (most-recent-email discipline)", async () => {
    await createAccount("fresh@fixture.test");
    const first = sandbox.pendingCodeFor("fresh@fixture.test");
    const res = await fetch(`${sandbox.url}/portal/sign-in`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: "fresh@fixture.test",
        password: "hunter2hunter2",
      }),
    });
    expect(res.headers.get("location")).toBe("/portal/verify");
    const second = sandbox.pendingCodeFor("fresh@fixture.test");
    expect(second).toMatch(/^\d{6}$/);
    // Only the NEWEST code works — the mailbox scanner must read the most
    // recent email, exactly the discipline the operator described.
    expect(second).not.toBe(first);
  });
});

describe("verification code delivery (UNIT_CONFIRMED)", () => {
  it("codes are 6 digits, leading zeros preserved", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateVerificationCode()).toMatch(/^\d{6}$/);
    }
  });

  it("without RESEND_API_KEY nothing is sent — console fallback", async () => {
    const d = await deliverVerificationCode({
      code: "123456",
      accountEmail: "x@fixture.test",
      env: {} as NodeJS.ProcessEnv,
      fetchImpl: (() => {
        throw new Error("must not be called");
      }) as unknown as typeof fetch,
    });
    expect(d.sent).toBe(false);
    expect(d.channel).toBe("console");
  });

  it("with key + recipient it posts the Resend shape; failures fail open", async () => {
    let captured: { url: string; body: string } | null = null;
    const okFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), body: String(init?.body) };
      return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
    }) as typeof fetch;
    const env = {
      RESEND_API_KEY: "re_test_key",
      SANDBOX_VERIFY_TO: "operator@fixture.test",
    } as unknown as NodeJS.ProcessEnv;
    const d = await deliverVerificationCode({
      code: "042042",
      accountEmail: "x@fixture.test",
      env,
      fetchImpl: okFetch,
    });
    expect(d.sent).toBe(true);
    expect(captured!.url).toBe("https://api.resend.com/emails");
    const body = JSON.parse(captured!.body) as {
      to: string[];
      text: string;
      html: string;
    };
    expect(body.to).toEqual(["operator@fixture.test"]);
    // The mail must read like a real tenant's so the scanner's patterns hit.
    expect(verificationEvidencePresent(body.text)).toBe(true);
    expect(body.text).toContain("042042");
    expect(body.html).toContain("042042");
    expect(body.html).not.toContain("x@fixture.test");

    const failFetch = (async () =>
      new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const refused = await deliverVerificationCode({
      code: "111111",
      accountEmail: "x@fixture.test",
      env,
      fetchImpl: failFetch,
    });
    expect(refused.sent).toBe(false);
    expect(refused.note).toMatch(/resend refused \(401\)/);
  });

  it("falls back to PORTAL_LOGIN_EMAIL as the recipient", async () => {
    let to: string[] = [];
    const capture = (async (_u: string | URL | Request, init?: RequestInit) => {
      to = (JSON.parse(String(init?.body)) as { to: string[] }).to;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const d = await deliverVerificationCode({
      code: "999999",
      accountEmail: "acct@fixture.test",
      env: {
        RESEND_API_KEY: "re_x",
        PORTAL_LOGIN_EMAIL: "standing@fixture.test",
      } as unknown as NodeJS.ProcessEnv,
      fetchImpl: capture,
    });
    expect(d.sent).toBe(true);
    expect(to).toEqual(["standing@fixture.test"]);
  });
});
