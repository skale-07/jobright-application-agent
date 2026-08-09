import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AshbyAdapterV1, ashbyFullNameMatcher } from "../../src/ats/ashby/v1.js";
import { validateAshbyApplicationUrl } from "../../src/ats/ashby/urlValidation.js";
import {
  discoverAshbyButtonGroups,
  looksLikeUnrenderedShell,
} from "../../src/ats/ashby/discovery.js";
import { annotateFullNameField } from "../../src/ats/shared/nameComposition.js";
import { loadAtsFixture } from "../../src/applications/atsFixtureInspect.js";
import { mapDiscoveredFields } from "../../src/applications/fieldNormalization.js";
import { buildFillPlan } from "../../src/applications/resolveAnswers.js";
import {
  assertExecutableApprovedEntry,
  toApprovedFillPlan,
} from "../../src/applications/approvedFillPlan.js";
import { parsePublicProfile } from "../../src/candidate/publicProfile.js";
import {
  applySafeFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";

const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures", "ats");

function loadAshbyFixture(name: string): {
  url: string;
  title: string;
  html: string;
} {
  const dir = path.join(FIXTURE_DIR, name);
  const html = fs.readFileSync(path.join(dir, "dom.sanitized.html"), "utf8");
  const metaPath = path.join(dir, "meta.json");
  const meta = fs.existsSync(metaPath)
    ? (JSON.parse(fs.readFileSync(metaPath, "utf8")) as {
        url: string;
        title: string;
      })
    : { url: `https://fixture.local/${name}`, title: name };
  return { url: meta.url, title: meta.title, html };
}

const TEST_ALIASES: Record<string, string[]> = {
  "legal_name.first": ["First name"],
  "legal_name.last": ["Last name"],
  email: ["Email"],
  phone: ["Phone"],
  "address.country": ["Country"],
  work_authorization: ["Are you legally authorized to work"],
};

const PROFILE = parsePublicProfile({
  legal_name: { first: "Ada", last: "Lovelace" },
  email: "ada@example.com",
  phone: "555-0100",
  address: { country: "United States" },
  work_authorization: "Yes",
});

const WORKAUTH_GROUP_ID = "c0ffee00-1111-2222-3333-444455556666";
const GENDER_GROUP_ID = "eeee5555-6666-7777-8888-99990000aaaa";
const COUNTRY_COMBOBOX_ID = "dddd4444-eeee-ffff-0000-111122223333";

async function buildApprovedAshbyPlan(profile = PROFILE) {
  const adapter = new AshbyAdapterV1();
  const fixture = loadAshbyFixture("ashby");
  const fields = await adapter.discoverFields({ html: fixture.html });
  const mapped = annotateFullNameField(
    mapDiscoveredFields(fields, TEST_ALIASES),
    ashbyFullNameMatcher,
  );
  const plan = buildFillPlan(mapped, profile);
  const approved = toApprovedFillPlan(plan.entries);
  adapter.setFillContext(plan.entries, fields);
  adapter.setApprovedFillPlan(approved, profile);
  return { adapter, fields, plan, composed: adapter.getApprovedFillPlan()! };
}

describe("Ashby adapter M4 (UNIT_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  beforeEach(() => {
    applySafeFillEnv();
  });

  describe("detect", () => {
    it("matches the rendered ashby fixture with confidence >= 0.5", async () => {
      const adapter = new AshbyAdapterV1();
      const d = await adapter.detect(loadAshbyFixture("ashby"));
      expect(d.matched).toBe(true);
      expect(d.atsId).toBe("ashby");
      expect(d.evidence).toContain("ashby URL host");
      expect(d.evidence).toContain("ashby form markers");
    });

    it("matches the unrendered shell via host + app-shell markers", async () => {
      const adapter = new AshbyAdapterV1();
      const shell = loadAshbyFixture("ashby-shell");
      const d = await adapter.detect({
        url: "https://jobs.ashbyhq.com/acme/9b1e0c2a-1234-4abc-8def-1234567890ab",
        html: shell.html,
      });
      expect(d.matched).toBe(true);
    });

    it("rejects the greenhouse fixture", async () => {
      const adapter = new AshbyAdapterV1();
      const d = await adapter.detect(loadAtsFixture("greenhouse"));
      expect(d.matched).toBe(false);
    });
  });

  describe("validateAshbyApplicationUrl", () => {
    const JOB =
      "https://jobs.ashbyhq.com/acme/9b1e0c2a-1234-4abc-8def-1234567890ab";

    it("accepts a full /application URL", () => {
      const v = validateAshbyApplicationUrl(`${JOB}/application`);
      expect(v.passed).toBe(true);
      expect(v.normalizedUrl).toBe(`${JOB}/application`);
      expect(v.org).toBe("acme");
      expect(v.jobId).toBe("9b1e0c2a-1234-4abc-8def-1234567890ab");
    });

    it("normalizes a job URL without /application and warns", () => {
      const v = validateAshbyApplicationUrl(JOB);
      expect(v.passed).toBe(true);
      expect(v.normalizedUrl).toBe(`${JOB}/application`);
      expect(v.warnings.some((w) => /without \/application/.test(w))).toBe(true);
    });

    const rejects: Array<[string, string, RegExp]> = [
      ["http", "http://jobs.ashbyhq.com/acme/9b1e0c2a-1234-4abc-8def-1234567890ab", /Non-HTTPS/],
      ["credentials", "https://u:p@jobs.ashbyhq.com/acme/9b1e0c2a-1234-4abc-8def-1234567890ab", /credentials/],
      ["marketing ashbyhq.com host", "https://www.ashbyhq.com/customers", /not allowlisted/],
      ["non-ashby host", "https://jobs.lever.co/acme/9b1e0c2a-1234-4abc-8def-1234567890ab", /Non-Ashby host/],
      ["root path", "https://jobs.ashbyhq.com/", /root URL/],
      ["non-uuid job id", "https://jobs.ashbyhq.com/acme/12345", /not a recognizable/],
      ["javascript scheme", "javascript:alert(1)", /Forbidden URL scheme/],
    ];
    for (const [label, url, re] of rejects) {
      it(`rejects ${label}`, () => {
        const v = validateAshbyApplicationUrl(url);
        expect(v.passed).toBe(false);
        expect(v.failureReason).toMatch(re);
      });
    }
  });

  describe("augmented discovery", () => {
    it("finds _systemfield_* inputs including the CSS-hidden resume file input", async () => {
      const adapter = new AshbyAdapterV1();
      const { html } = loadAshbyFixture("ashby");
      const fields = await adapter.discoverFields({ html });
      const byId = new Map(fields.map((f) => [f.id, f]));

      expect(byId.get("_systemfield_name")).toMatchObject({
        label: "Full name",
        type: "text",
        required: true,
      });
      expect(byId.get("_systemfield_email")).toMatchObject({
        type: "text",
        required: true,
      });
      expect(byId.get("_systemfield_phone")?.type).toBe("text");
      expect(byId.get("_systemfield_resume")).toMatchObject({
        label: "Resume",
        type: "file",
        required: true,
      });
      expect(byId.get(COUNTRY_COMBOBOX_ID)).toMatchObject({
        label: "Country",
        type: "text",
      });
    });

    it("emits button groups as radio-typed fields with UUID ids and option labels", () => {
      const { html } = loadAshbyFixture("ashby");
      const groups = discoverAshbyButtonGroups(html);
      expect(groups).toHaveLength(2);

      const workauth = groups.find((g) => g.id === WORKAUTH_GROUP_ID)!;
      expect(workauth.type).toBe("radio");
      expect(workauth.required).toBe(true);
      expect(workauth.label).toBe(
        "Are you legally authorized to work in the United States?",
      );
      expect(workauth.options).toEqual(["Yes", "No"]);

      const gender = groups.find((g) => g.id === GENDER_GROUP_ID)!;
      expect(gender.label).toMatch(/Gender identity/);
      expect(gender.options).toContain("Decline to self-identify");
    });

    it("flags the unrendered shell and discovers nothing from it", async () => {
      const shell = loadAshbyFixture("ashby-shell");
      expect(looksLikeUnrenderedShell(shell.html)).toBe(true);
      expect(
        looksLikeUnrenderedShell(loadAshbyFixture("ashby").html),
      ).toBe(false);

      const adapter = new AshbyAdapterV1();
      const fields = await adapter.discoverFields({ html: shell.html });
      expect(fields).toHaveLength(0);

      const inspection = await adapter.inspect({
        url: "https://jobs.ashbyhq.com/acme/9b1e0c2a-1234-4abc-8def-1234567890ab/application",
        html: shell.html,
      });
      expect(
        inspection.warnings.some((w) => /unrendered shell/.test(w)),
      ).toBe(true);
    });
  });

  describe("plan pipeline", () => {
    it("composes the full name and approves email/phone/country/work-auth", async () => {
      const { composed } = await buildApprovedAshbyPlan();
      const byId = new Map(composed.entries.map((e) => [e.field_id, e]));

      const nameEntry = byId.get("_systemfield_name")!;
      expect(nameEntry.approved).toBe(true);
      expect(nameEntry.value).toBe("Ada Lovelace");
      expect(nameEntry.reason).toMatch(/composed/);
      expect(() => assertExecutableApprovedEntry(nameEntry)).not.toThrow();

      expect(byId.get("_systemfield_email")).toMatchObject({
        approved: true,
        value: "ada@example.com",
      });
      expect(byId.get(COUNTRY_COMBOBOX_ID)).toMatchObject({
        approved: true,
        canonical_field: "address.country",
        value: "United States",
      });
      expect(byId.get(WORKAUTH_GROUP_ID)).toMatchObject({
        approved: true,
        canonical_field: "work_authorization",
        value: "Yes",
        type: "radio",
      });
    });

    it("routes essay, demographics group, file, and unmapped fields away from fill", async () => {
      const { composed } = await buildApprovedAshbyPlan();
      const byId = new Map(composed.entries.map((e) => [e.field_id, e]));

      expect(byId.get("bbbb2222-cccc-dddd-eeee-ffff00002222")).toMatchObject({
        action: "SKIP",
        approved: false,
      });
      const gender = byId.get(GENDER_GROUP_ID)!;
      expect(gender.action).toBe("SKIP");
      expect(gender.reason).toMatch(/[Dd]emographics/);
      expect(byId.get("_systemfield_resume")).toMatchObject({ action: "SKIP" });
      expect(byId.get("aaaa1111-bbbb-cccc-dddd-eeee00001111")).toMatchObject({
        action: "SKIP",
      });
      expect(() => assertExecutableApprovedEntry(gender)).toThrow(/not approved/);
    });
  });
});

describe("ashby radiogroup discovery — live Cohere shapes (UNIT_CONFIRMED)", () => {
  it("role=radio divs with nested markup and a trailing submit button", () => {
    const html = `
      <div role="radiogroup" aria-required="true" aria-labelledby="lbl-edu">
        <h4 id="lbl-edu">Please select the current level of education you are pursuing*</h4>
        <div class="row"><div role="radio" aria-checked="false"><span>Undergrad</span></div></div>
        <div class="row"><div role="radio" aria-checked="false">Master's/MBA</div></div>
        <div class="row"><div role="radio" aria-checked="false">PhD</div></div>
      </div>
      <button type="button">Submit application</button>`;
    const groups = discoverAshbyButtonGroups(html);
    expect(groups.length).toBe(1);
    expect(groups[0]!.label).toBe(
      "Please select the current level of education you are pursuing",
    );
    expect(groups[0]!.options).toEqual(["Undergrad", "Master's/MBA", "PhD"]);
    expect(groups[0]!.required).toBe(true);
    // The trailing submit button is NOT an option (window ends at the
    // group's real closing tag, not at the next radiogroup/EOF).
    expect(groups[0]!.options).not.toContain("Submit application");
  });

  it("native radio inputs wrapped in labels", () => {
    const html = `
      <fieldset role="radiogroup" aria-required="true" aria-label="Are you available for a full-time internship?">
        <label><input type="radio" name="avail" value="yes"> Yes</label>
        <label><input type="radio" name="avail" value="no"> No</label>
      </fieldset>`;
    const groups = discoverAshbyButtonGroups(html);
    expect(groups.length).toBe(1);
    expect(groups[0]!.options).toEqual(["Yes", "No"]);
  });

  it("two adjacent groups stay separate with their own options", () => {
    const html = `
      <div role="radiogroup" aria-labelledby="a"><h4 id="a">Q1</h4>
        <div role="radio">Yes</div><div role="radio">No</div>
      </div>
      <div role="radiogroup" aria-labelledby="b"><h4 id="b">Q2</h4>
        <div role="radio">Remote</div><div role="radio">Hybrid</div><div role="radio">On-site</div>
      </div>`;
    const groups = discoverAshbyButtonGroups(html);
    expect(groups.map((g) => g.options.length)).toEqual([2, 3]);
  });
});
