import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planApplicationFill } from "../../src/applications/applicationFiller.js";
import { ashbyDiscoverFields, discoverAshbyFieldsetGroups } from "../../src/ats/ashby/discovery.js";
import { inspectApplicationHtml } from "../../src/applications/applicationInspector.js";
import { resetConfigCache } from "../../src/config/index.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";
import type { EmailLlmClient } from "../../src/contacts/emailLlm.js";

/**
 * THE PREDICTIVE GAUNTLET (operator directive 2026-08-15).
 *
 * "again i dont think the llm predictive system is functional at all …
 *  what might be helpful is developing a test script/suite that creates
 *  frontend mimicking a job application with really weird, odd questions
 *  that the system would need predictive capabilities for."
 *
 * Every question in the fixture is deliberately outside the deterministic
 *  registry — no screener pattern, no alias, no profile rule. A fill here
 * proves the PREDICT wiring end to end: options reach the model, the
 * model's choice is validated verbatim, an off-list answer takes the
 * form's own "Other", and abstention parks. The mock client stands in for
 * the API; the wiring under test is identical to production.
 *
 * Run 2a9f9930 ground truth this defends against: SCREENER_PREDICT was ON
 * and the tier still answered nothing — the questions never reached it.
 */
const GAUNTLET_HTML = fs.readFileSync(
  path.join(process.cwd(), "tests", "fixtures", "gauntlet", "weird-application.html"),
  "utf8",
);

/** A scripted "model": answers by looking at the question, like the real one. */
function scriptedClient(
  script: Record<string, string | null>,
): EmailLlmClient {
  return {
    async generateJson({ user }: { system: string; user: string }) {
      const payload = JSON.parse(user) as {
        questions?: Array<{ label: string; options?: string[] }>;
        items?: Array<{ key: string; question: string; options: string[] }>;
      };
      if (payload.questions) {
        const predictions = payload.questions.map((q) => {
          const hit = Object.entries(script).find(([k]) => q.label.includes(k));
          return {
            label: q.label,
            answer: hit ? hit[1] : null,
            key: "gauntlet_answer",
            basis: "scripted gauntlet client",
          };
        });
        return { text: JSON.stringify({ predictions }) };
      }
      const choices = (payload.items ?? []).map((i) => {
        const hit = Object.entries(script).find(([k]) => i.question.includes(k));
        return { key: i.key, option: hit ? hit[1] : null };
      });
      return { text: JSON.stringify({ choices }) };
    },
  } as unknown as EmailLlmClient;
}

describe("predictive gauntlet (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  let privDir: string;
  let priorPrivate: string | undefined;
  beforeEach(() => {
    // The predict tier is flag-gated; the gauntlet enables it with a MOCK
    // client — no key, no network, restored by the isolated-env helper.
    process.env.SCREENER_PREDICT_LLM_ENABLED = "true";
    // The tuned predict path PERSISTS accepted answers into the bank
    // (learned answers). Point the bank at a throwaway dir so the gauntlet
    // measures the tiers, not what a previous test taught them — the full
    // suite leaked "Other" into the appliance question without this.
    priorPrivate = process.env.PRIVATE_DIR;
    privDir = path.join(os.tmpdir(), `gauntlet-priv-${randomUUID()}`);
    fs.mkdirSync(path.join(privDir, "candidate"), { recursive: true });
    // The planner needs a profile; use the repo's example (which is also
    // where the university test's "true answer" comes from).
    fs.copyFileSync(
      path.join(process.cwd(), "private", "candidate", "public-profile.example.json"),
      path.join(privDir, "candidate", "public-profile.json"),
    );
    process.env.PRIVATE_DIR = privDir;
    resetConfigCache();
  });
  afterEach(() => {
    delete process.env.SCREENER_PREDICT_LLM_ENABLED;
    if (priorPrivate === undefined) delete process.env.PRIVATE_DIR;
    else process.env.PRIVATE_DIR = priorPrivate;
    resetConfigCache();
    fs.rmSync(privDir, { recursive: true, force: true });
  });

  it("weird CLOSED questions fill from the model's verbatim option choice", async () => {
    const { approvedPlan } = await planApplicationFill({
      url: "https://careers.frobnicator-example.com/apply/1",
      html: GAUNTLET_HTML,
      llmClient: scriptedClient({
        "kitchen appliance": "Rice cooker",
        "COBOL": "No",
        "time zone": "Eastern (US)",
      }),
    });
    const byLabel = new Map(approvedPlan.entries.map((e) => [e.label, e]));
    expect(byLabel.get("If you were a kitchen appliance, which would you be?")?.value).toBe(
      "Rice cooker",
    );
    expect(
      byLabel.get("Have you ever maintained a COBOL system in production?")?.value,
    ).toBe("No");
    expect(
      byLabel.get("Which time zone will you primarily frobnicate from?")?.value,
    ).toBe("Eastern (US)");
  }, 30_000);

  it('an off-list answer takes the form\'s own "Other" and keeps the real answer', async () => {
    const { approvedPlan, otherFallbacks } = await planApplicationFill({
      url: "https://careers.frobnicator-example.com/apply/1",
      html: GAUNTLET_HTML,
      llmClient: scriptedClient({
        // The model answers the TRUE university, which is not on the list.
        "university": "Johns Hopkins University",
      }),
    });
    const uni = approvedPlan.entries.find((e) =>
      e.label.startsWith("Which university do you attend"),
    );
    expect(uni?.value).toBe("Other");
    const fb = otherFallbacks.find((o) => o.field_id === "q_uni");
    expect(fb?.intended).toBe("Johns Hopkins University");
  }, 30_000);

  it("an invented option that matches nothing NEVER fills — it parks", async () => {
    const { approvedPlan } = await planApplicationFill({
      url: "https://careers.frobnicator-example.com/apply/1",
      html: GAUNTLET_HTML,
      llmClient: scriptedClient({
        // No "Other" rescue possible: "Microwave" is not on the list and
        // the appliance list DOES have Other — so Other fires. Time zone
        // has NO Other and gets an invented city: must park.
        "time zone": "Atlantis Standard Time",
      }),
    });
    const tz = approvedPlan.entries.find((e) =>
      e.label.includes("time zone"),
    );
    expect(tz?.value ?? "").not.toBe("Atlantis Standard Time");
    expect(String(tz?.action)).not.toBe("FILL");
  }, 30_000);

  it("abstention (null) parks the question instead of guessing", async () => {
    const { approvedPlan } = await planApplicationFill({
      url: "https://careers.frobnicator-example.com/apply/1",
      html: GAUNTLET_HTML,
      llmClient: scriptedClient({}), // the model answers nothing
    });
    for (const label of [
      "If you were a kitchen appliance, which would you be?",
      "Have you ever maintained a COBOL system in production?",
    ]) {
      const e = approvedPlan.entries.find((x) => x.label === label);
      expect(String(e?.action)).not.toBe("FILL");
    }
  }, 30_000);

  it("with the flag OFF the gauntlet fills nothing (fail-closed)", async () => {
    delete process.env.SCREENER_PREDICT_LLM_ENABLED;
    resetConfigCache();
    const { approvedPlan } = await planApplicationFill({
      url: "https://careers.frobnicator-example.com/apply/1",
      html: GAUNTLET_HTML,
      llmClient: scriptedClient({ "kitchen appliance": "Toaster" }),
    });
    const e = approvedPlan.entries.find((x) => x.label.includes("kitchen appliance"));
    expect(String(e?.action)).not.toBe("FILL");
  }, 30_000);
});

/**
 * Ashby fieldset grouping (fix 3): the live 2026-08-15 shape — fieldset +
 * question-title label + per-option inputs — must surface as ONE question
 * with options, not N per-option fields. Both live variants covered.
 */
describe("ashby fieldset question grouping (UNIT_CONFIRMED)", () => {
  // Checkbox variant (pronouns): option text lives in name= AND the label.
  const CHECKBOX_FIELDSET = `
    <div data-field-path="aaa-111">
      <fieldset>
        <label class="_heading _required_x ashby-application-form-question-title" for="aaa-111">How did you hear about Frobnicator?</label>
        <div><input type="checkbox" id="e1_aaa-111-labeled-checkbox-0" name="LinkedIn"><label for="e1_aaa-111-labeled-checkbox-0">LinkedIn</label></div>
        <div><input type="checkbox" id="e1_aaa-111-labeled-checkbox-1" name="A friend"><label for="e1_aaa-111-labeled-checkbox-1">A friend</label></div>
        <div><input type="checkbox" id="e1_aaa-111-labeled-checkbox-2" name="Other"><label for="e1_aaa-111-labeled-checkbox-2">Other</label></div>
      </fieldset>
    </div>`;
  // Radio variant (age): every input shares the entry-uuid name; option
  // text ONLY in the sibling label — the shape that used to surface as a
  // field labeled "Under 30".
  const RADIO_FIELDSET = `
    <div data-field-path="bbb-222">
      <fieldset>
        <label class="_heading ashby-application-form-question-title" for="bbb-222">What is your current age?</label>
        <div><input type="radio" id="e2_bbb-222-labeled-radio-0" name="e2_bbb-222"><label for="e2_bbb-222-labeled-radio-0">Under 30</label></div>
        <div><input type="radio" id="e2_bbb-222-labeled-radio-1" name="e2_bbb-222"><label for="e2_bbb-222-labeled-radio-1">30-39</label></div>
        <div><input type="radio" id="e2_bbb-222-labeled-radio-2" name="e2_bbb-222"><label for="e2_bbb-222-labeled-radio-2">I prefer not to answer</label></div>
      </fieldset>
    </div>`;
  const PAGE = `<html><body>${CHECKBOX_FIELDSET}${RADIO_FIELDSET}
    <label for="fn">First Name</label><input id="fn" name="fn" type="text" />
  </body></html>`;

  it("one QUESTION per fieldset, labeled by its title, options from the labels", () => {
    const { fields } = discoverAshbyFieldsetGroups(PAGE);
    expect(fields).toHaveLength(2);
    expect(fields[0]).toMatchObject({
      id: "aaa-111",
      label: "How did you hear about Frobnicator?",
      required: true,
      options: ["LinkedIn", "A friend", "Other"],
    });
    expect(fields[1]).toMatchObject({
      label: "What is your current age?",
      options: ["Under 30", "30-39", "I prefer not to answer"],
    });
  });

  it("per-option fields are suppressed — the plan sees each question ONCE", () => {
    const fields = ashbyDiscoverFields(PAGE);
    const labels = fields.map((f) => f.label);
    // The question labels are present…
    expect(labels).toContain("How did you hear about Frobnicator?");
    expect(labels).toContain("What is your current age?");
    // …the option-shaped fields are gone (live run: 38 of these per form)…
    expect(labels).not.toContain("LinkedIn");
    expect(labels).not.toContain("A friend");
    expect(labels).not.toContain("Under 30");
    // …and ordinary inputs still discover.
    expect(labels).toContain("First Name");
  });

  it("a single checkbox is consent, never a one-option question", () => {
    const html = `<html><body><fieldset>
      <label class="ashby-application-form-question-title" for="c1">I agree to the privacy policy</label>
      <div><input type="checkbox" id="e_c1-labeled-checkbox-0" name="agree"><label for="e_c1-labeled-checkbox-0">I agree</label></div>
    </fieldset></body></html>`;
    expect(discoverAshbyFieldsetGroups(html).fields).toHaveLength(0);
  });
});

/**
 * Inspection routing (fix 1): a URL-validated app whose page names no
 * vendor proceeds to fill instead of parking UNSUPPORTED_ATS. Live run
 * 2a9f9930: Paycom ×2, Oracle Cloud, ByteDance — four perfect navigations,
 * four "unsupported ATS" parks at exactly this decision.
 */
describe("vendor-unknown page on a validated URL (UNIT_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  const PAYCOM_LISTING = `<html><body>
    <h1>AI Engineer Intern</h1>
    <p>Strongsville, OH 44136</p>
    <button>Apply</button>
  </body></html>`;

  it("routes a generic-validated posting forward, not UNSUPPORTED", async () => {
    const report = await inspectApplicationHtml({
      url: "https://www.paycomonline.net/v4/ats/web.php/portal/ABC/jobs/327881",
      html: PAYCOM_LISTING,
    });
    expect(report.route).not.toBe("skip_unsupported_ats");
    expect(report.inspection.ats).toBe("generic");
  });

  it("an auth-walled account modal routes to the portal-auth path", async () => {
    const html = `<html><head><title>Sign in</title></head><body>
      <h2>Getting You Started</h2>
      <form action="/login"><input type="email" name="email"/><input type="password" name="pw"/>
      <button>Log In to continue</button></form>
    </body></html>`;
    const report = await inspectApplicationHtml({
      url: "https://www.paycomonline.net/v4/ats/web.php/portal/ABC/jobs/327881",
      html,
    });
    expect(report.route).toBe("needs_login");
  });

  it("a URL claimed by NO adapter still parks as unsupported", async () => {
    const report = await inspectApplicationHtml({
      url: "http://insecure.example.com/apply",
      html: PAYCOM_LISTING,
    });
    expect(report.route).toBe("skip_unsupported_ats");
  });
});
