import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { LeverAdapterV1, leverFullNameMatcher } from "../../src/ats/lever/v1.js";
import { validateLeverApplicationUrl } from "../../src/ats/lever/urlValidation.js";
import {
  annotateFullNameField,
  composeFullName,
  makeFullNameMatcher,
} from "../../src/ats/shared/nameComposition.js";
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

// Lever is not in ATS_FIXTURE_NAMES (unwired adapter) — load by direct path,
// same as the greenhouse-combobox fixture tests.
export function loadLeverFixture(name = "lever"): {
  url: string;
  title: string;
  html: string;
} {
  const dir = path.join(process.cwd(), "tests", "fixtures", "ats", name);
  const html = fs.readFileSync(path.join(dir, "dom.sanitized.html"), "utf8");
  const meta = JSON.parse(
    fs.readFileSync(path.join(dir, "meta.json"), "utf8"),
  ) as { url: string; title: string };
  return { url: meta.url, title: meta.title, html };
}

// Tests never depend on private/candidate files — aliases are explicit.
const TEST_ALIASES: Record<string, string[]> = {
  "legal_name.first": ["First name"],
  "legal_name.last": ["Last name"],
  email: ["Email"],
  phone: ["Phone"],
  linkedin_url: ["LinkedIn URL"],
  github_url: ["GitHub URL"],
  personal_website: ["Portfolio URL"],
  work_authorization: ["Are you legally authorized to work"],
};

const PROFILE = parsePublicProfile({
  legal_name: { first: "Ada", last: "Lovelace" },
  email: "ada@example.com",
  phone: "555-0100",
  linkedin_url: "https://linkedin.com/in/ada-example",
  github_url: "https://github.com/ada-example",
  personal_website: "https://ada.example",
  work_authorization: "Yes",
});

function buildApprovedLeverPlan(profile = PROFILE) {
  const adapter = new LeverAdapterV1();
  const fixture = loadLeverFixture();
  return (async () => {
    const fields = await adapter.discoverFields({ html: fixture.html });
    const mapped = annotateFullNameField(
      mapDiscoveredFields(fields, TEST_ALIASES),
      leverFullNameMatcher,
    );
    const plan = buildFillPlan(mapped, profile);
    const approved = toApprovedFillPlan(plan.entries);
    adapter.setFillContext(plan.entries, fields);
    adapter.setApprovedFillPlan(approved, profile);
    return { adapter, fields, mapped, plan, composed: adapter.getApprovedFillPlan()! };
  })();
}

describe("Lever adapter M1 (UNIT_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  beforeEach(() => {
    applySafeFillEnv();
  });

  describe("detect", () => {
    it("matches the lever fixture URL + form markers with confidence >= 0.5", async () => {
      const adapter = new LeverAdapterV1();
      const f = loadLeverFixture();
      const d = await adapter.detect(f);
      expect(d.matched).toBe(true);
      expect(d.confidence).toBeGreaterThanOrEqual(0.5);
      expect(d.atsId).toBe("lever");
      expect(d.evidence).toContain("lever URL host");
      expect(d.evidence).toContain("lever form markers");
    });

    it("rejects the greenhouse fixture", async () => {
      const adapter = new LeverAdapterV1();
      const f = loadAtsFixture("greenhouse");
      const d = await adapter.detect(f);
      expect(d.matched).toBe(false);
    });

    it("markers alone (no lever URL) stay below the match threshold", async () => {
      const adapter = new LeverAdapterV1();
      const f = loadLeverFixture();
      const d = await adapter.detect({
        url: "https://careers.example.com/apply",
        html: f.html.replace(/jobs\.lever\.co/g, "careers.example.com"),
      });
      expect(d.matched).toBe(false);
    });
  });

  describe("validateLeverApplicationUrl", () => {
    const POSTING =
      "https://jobs.lever.co/acme/a1b2c3d4-e5f6-7890-abcd-ef1234567890";

    it("accepts a full /apply URL and normalizes casing", () => {
      const v = validateLeverApplicationUrl(`${POSTING}/apply`);
      expect(v.passed).toBe(true);
      expect(v.normalizedUrl).toBe(`${POSTING}/apply`);
      expect(v.company).toBe("acme");
      expect(v.postingId).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    });

    it("normalizes a posting URL without /apply and warns", () => {
      const v = validateLeverApplicationUrl(POSTING);
      expect(v.passed).toBe(true);
      expect(v.normalizedUrl).toBe(`${POSTING}/apply`);
      expect(v.warnings.some((w) => /without \/apply/.test(w))).toBe(true);
    });

    it("accepts the EU host", () => {
      const v = validateLeverApplicationUrl(
        "https://jobs.eu.lever.co/acme/a1b2c3d4-e5f6-7890-abcd-ef1234567890/apply",
      );
      expect(v.passed).toBe(true);
      expect(v.host).toBe("jobs.eu.lever.co");
    });

    const rejects: Array<[string, string, RegExp]> = [
      ["http", `http://jobs.lever.co/acme/a1b2c3d4-e5f6-7890-abcd-ef1234567890`, /Non-HTTPS/],
      ["credentials", `https://user:pw@jobs.lever.co/acme/a1b2c3d4-e5f6-7890-abcd-ef1234567890`, /credentials/],
      ["port", `https://jobs.lever.co:8443/acme/a1b2c3d4-e5f6-7890-abcd-ef1234567890`, /port/],
      ["marketing lever.co host", "https://www.lever.co/customers", /not allowlisted/],
      ["non-lever host", "https://jobs.ashbyhq.com/acme/a1b2c3d4-e5f6-7890-abcd-ef1234567890", /Non-Lever host/],
      ["root path", "https://jobs.lever.co/", /root URL/],
      ["malformed posting id", "https://jobs.lever.co/acme/12345", /not a recognizable/],
      ["javascript scheme", "javascript:alert(1)", /Forbidden URL scheme/],
      ["empty", "   ", /Empty URL/],
    ];
    for (const [label, url, re] of rejects) {
      it(`rejects ${label}`, () => {
        const v = validateLeverApplicationUrl(url);
        expect(v.passed).toBe(false);
        expect(v.failureReason).toMatch(re);
      });
    }
  });

  describe("discovery", () => {
    it("finds the lever field set with correct types and required flags", async () => {
      const adapter = new LeverAdapterV1();
      const { html } = loadLeverFixture();
      const fields = await adapter.discoverFields({ html });
      const byId = new Map(fields.map((f) => [f.id, f]));

      expect(byId.get("name")).toMatchObject({
        label: "Full name",
        type: "text",
        required: true,
        name: "name",
      });
      expect(byId.get("email")).toMatchObject({ type: "text", required: true });
      expect(byId.get("phone")).toMatchObject({ type: "text", required: false });
      expect(byId.get("resume-upload-input")).toMatchObject({
        type: "file",
        required: true,
        name: "resume",
      });
      expect(byId.get("comments")).toMatchObject({ type: "textarea" });
      expect(byId.get("card-workauth")?.type).toBe("select");
      expect(byId.get("card-workauth")?.options).toEqual([
        "Select ...",
        "Yes",
        "No",
      ]);
      expect(byId.get("eeo-gender")?.type).toBe("select");
      expect(byId.get("eeo-gender")?.options).toContain(
        "Decline to self-identify",
      );
      expect(byId.get("urls-linkedin")?.name).toBe("urls[LinkedIn]");
    });
  });

  describe("plan pipeline with full-name composition", () => {
    it("composes 'Ada Lovelace' into the single name field via legal_name canonicals", async () => {
      const { composed } = await buildApprovedLeverPlan();
      const nameEntry = composed.entries.find((e) => e.field_id === "name")!;
      expect(nameEntry.action).toBe("FILL");
      expect(nameEntry.approved).toBe(true);
      expect(nameEntry.canonical_field).toBe("legal_name.first");
      expect(nameEntry.value).toBe("Ada Lovelace");
      expect(nameEntry.reason).toMatch(/composed legal_name\.first \+ legal_name\.last/);
      expect(composed.answers["legal_name.first"]).toBe("Ada Lovelace");
      expect(() => assertExecutableApprovedEntry(nameEntry)).not.toThrow();
    });

    it("routes essay, demographics, files, and unmapped fields away from fill", async () => {
      const { composed } = await buildApprovedLeverPlan();
      const byId = new Map(composed.entries.map((e) => [e.field_id, e]));

      expect(byId.get("comments")).toMatchObject({ action: "SKIP", approved: false });
      for (const eeo of ["eeo-gender", "eeo-race", "eeo-veteran"]) {
        const entry = byId.get(eeo)!;
        expect(entry.action).toBe("SKIP");
        expect(entry.approved).toBe(false);
        expect(entry.reason).toMatch(/[Dd]emographics/);
      }
      expect(byId.get("resume-upload-input")).toMatchObject({
        action: "SKIP",
        approved: false,
      });
      expect(byId.get("card-hearabout")).toMatchObject({
        action: "SKIP",
        approved: false,
      });
    });

    it("approves direct canonicals: email, phone, urls, work authorization", async () => {
      const { composed } = await buildApprovedLeverPlan();
      const byId = new Map(composed.entries.map((e) => [e.field_id, e]));
      expect(byId.get("email")).toMatchObject({ approved: true, value: "ada@example.com" });
      expect(byId.get("phone")).toMatchObject({ approved: true, value: "555-0100" });
      expect(byId.get("urls-linkedin")).toMatchObject({
        approved: true,
        canonical_field: "linkedin_url",
      });
      expect(byId.get("urls-github")).toMatchObject({ approved: true });
      expect(byId.get("urls-portfolio")).toMatchObject({
        approved: true,
        canonical_field: "personal_website",
      });
      expect(byId.get("card-workauth")).toMatchObject({
        approved: true,
        canonical_field: "work_authorization",
        value: "Yes",
      });
      expect(byId.get("org")).toMatchObject({ action: "SKIP" });
    });

    it("fails closed to REVIEW_REQUIRED when the last name is missing", async () => {
      const profile = parsePublicProfile({
        legal_name: { first: "Ada", last: "" },
        email: "ada@example.com",
      });
      const { composed } = await buildApprovedLeverPlan(profile);
      const nameEntry = composed.entries.find((e) => e.field_id === "name")!;
      expect(nameEntry.action).toBe("REVIEW_REQUIRED");
      expect(nameEntry.approved).toBe(false);
      expect(nameEntry.value).toBeNull();
      expect(composed.answers["legal_name.first"]).toBeUndefined();
      expect(() => assertExecutableApprovedEntry(nameEntry)).toThrow(/not approved/);
    });

    it("never overrides an existing canonical mapping when annotating", () => {
      const mapped = mapDiscoveredFields(
        [
          {
            id: "first_name",
            label: "First name",
            type: "text" as const,
            required: true,
            name: "first_name",
          },
        ],
        TEST_ALIASES,
      );
      const annotated = annotateFullNameField(mapped, leverFullNameMatcher);
      expect(annotated[0]!.canonical_field).toBe("legal_name.first");
      expect(annotated[0]!.mapping_confidence).toBe("high");
    });

    it("composes even when the input's id differs from its name attribute", async () => {
      // Review finding: entries carry field_id = inputId, but the matcher's
      // fieldNames refer to name attributes — the adapter resolves the
      // mapping through FieldMeta so composition still fires.
      const adapter = new LeverAdapterV1();
      const fields = [
        {
          id: "field-7f3a",
          label: "Name",
          type: "text" as const,
          required: true,
          name: "name",
          inputId: "field-7f3a",
        },
      ];
      const mapped = annotateFullNameField(
        mapDiscoveredFields(fields, TEST_ALIASES),
        leverFullNameMatcher,
      );
      const plan = buildFillPlan(mapped, PROFILE);
      const approved = toApprovedFillPlan(plan.entries);
      adapter.setFillContext(plan.entries, fields);
      adapter.setApprovedFillPlan(approved, PROFILE);
      const composed = adapter.getApprovedFillPlan()!;
      const entry = composed.entries.find((e) => e.field_id === "field-7f3a")!;
      expect(entry.value).toBe("Ada Lovelace");
      expect(entry.reason).toMatch(/composed/);
    });

    it("composeFullName leaves non-matching plans untouched", () => {
      const matcher = makeFullNameMatcher({
        fieldNames: ["nonexistent"],
        labelPattern: /^never matches$/,
      });
      const approved = toApprovedFillPlan([]);
      const out = composeFullName(approved, PROFILE, matcher);
      expect(out).toBe(approved);
    });

    it("rejects a forged demographics entry at the executable-entry guard", () => {
      expect(() =>
        assertExecutableApprovedEntry({
          field_id: "eeo-gender",
          label: "Gender",
          type: "select",
          canonical_field: "legal_name.first",
          action: "FILL",
          approved: true,
          value: "X",
          reason: "forged",
        }),
      ).toThrow(/demographics/);
    });
  });

  describe("inspect", () => {
    it("reports dormant hCaptcha as a warning, not blocking", async () => {
      const adapter = new LeverAdapterV1();
      const f = loadLeverFixture();
      const inspection = await adapter.inspect(f);
      expect(inspection.ats).toBe("lever");
      expect(inspection.captcha_detected).toBe(false);
      expect(inspection.requires_login).toBe(false);
      expect(
        inspection.warnings.some((w) => /Dormant CAPTCHA markers/.test(w)),
      ).toBe(true);
      expect(inspection.fields.length).toBeGreaterThanOrEqual(12);
    });
  });
});
