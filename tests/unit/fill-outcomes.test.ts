import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, migrate, openDatabase, type Db } from "../../src/storage/db/client.js";
import {
  buildFillFieldOutcomes,
  classifyValue,
  exportFillOutcomesJsonl,
  recordFillRun,
  redactOutcomeValue,
  summarizeFillOutcomes,
  valueFingerprint,
  type RecordFillRunInput,
} from "../../src/storage/fillOutcomes.js";

function syntheticInput(
  overrides: Partial<RecordFillRunInput> = {},
): RecordFillRunInput {
  return {
    mode: "executed",
    source: "cli_url",
    ats: "greenhouse",
    job_url:
      "https://job-boards.greenhouse.io/simplifyjobsintegrationsandbox/jobs/4344358003",
    company: "simplifyjobsintegrationsandbox",
    role: "Software Engineer Intern",
    job_id_observed: "4344358003",
    mutation_attempted: true,
    validation_level: "UNVERIFIED",
    fillable_count: 3,
    skipped_count: 1,
    notes: ["heal pass: recovered 0/1"],
    plan_entries: [
      {
        field_id: "first_name",
        label: "First Name",
        type: "text",
        canonical_field: "legal_name.first",
        action: "FILL",
        approved: true,
        value: "Shubham",
        reason: "Mapped from public profile",
      },
      {
        field_id: "email",
        label: "Email",
        type: "text",
        canonical_field: "email",
        action: "FILL",
        approved: true,
        value: "skale1@jh.edu",
        reason: "Mapped from public profile",
      },
      {
        field_id: "country",
        label: "Country",
        type: "text",
        canonical_field: "address.country",
        action: "FILL",
        approved: true,
        value: "United States",
        reason: "Mapped from public profile",
      },
      {
        field_id: "discipline--0",
        label: "Discipline",
        type: "text",
        canonical_field: "major",
        action: "FILL",
        approved: true,
        value: "Applied Math & Stats",
        reason: "Mapped from public profile",
      },
      {
        field_id: "phone",
        label: "Phone",
        type: "text",
        canonical_field: "phone",
        action: "FILL",
        approved: true,
        value: "410-555-7636",
        reason: "Mapped",
      },
      {
        field_id: "question_auth",
        label: "Are you authorized to work in the U.S.?",
        type: "text",
        canonical_field: "work_authorization",
        action: "FILL",
        approved: true,
        value: "Yes",
        reason: "Mapped",
      },
      {
        field_id: "gender",
        label: "Gender",
        type: "text",
        canonical_field: null,
        action: "skip_demographics",
        approved: false,
        value: null,
        reason: "Demographics deferred",
      },
    ],
    fill: {
      filled: [
        "legal_name.first",
        "email",
        "address.country",
        "major",
        "phone",
        "work_authorization",
      ],
      skipped: [],
      errors: [],
      field_meta: [
        {
          field_id: "country",
          canonical_field: "address.country",
          control_kind: "combobox",
          selected_option: "United States",
          match_via: "ci_exact",
          notes: [
            'picked "United States +1" (ci_exact)',
            'display collapsed to dial code; recording "United States"',
          ],
          options_sample: ["United States +1", "Canada +1"],
        },
        {
          field_id: "discipline--0",
          canonical_field: "major",
          control_kind: "combobox",
          selected_option: "Mathematics",
          match_via: "unique_substring",
          notes: ['picked "Mathematics" (unique_substring)'],
          options_sample: ["Mathematics", "Applied Health Services"],
        },
      ],
    },
    verify: {
      passed: false,
      fields: [
        {
          canonical_field: "legal_name.first",
          expected: "Shubham",
          observed: "Shubham",
          match: true,
        },
        {
          canonical_field: "email",
          expected: "skale1@jh.edu",
          observed: "skale1@jh.edu",
          match: true,
        },
        {
          canonical_field: "address.country",
          expected: "United States",
          observed: { value: "+1", label: "+1" },
          match: false,
        },
        {
          canonical_field: "major",
          expected: "Applied Math & Stats",
          observed: { value: "Mathematics", label: "Mathematics" },
          match: true,
        },
        {
          canonical_field: "phone",
          expected: "410-555-7636",
          observed: "4105557636",
          match: false,
        },
        {
          canonical_field: "work_authorization",
          expected: "Yes",
          observed: "Yes",
          match: true,
        },
      ],
      uploads: [],
      warnings: [],
    },
    uploads: [
      {
        field: "resume",
        path: "C:\\secret\\resume.pdf",
        filename: "resume.pdf",
        size_bytes: 1000,
        verified: true,
        evidence: "ok",
      },
    ],
    heal: {
      attempted: 2,
      healed: [],
      still_failing: ["country", "phone"],
      attempts: [
        {
          field_id: "country",
          layer: null,
          candidate: null,
          healed: false,
          notes: ["heuristic candidate did not verify"],
        },
        {
          field_id: "phone",
          layer: null,
          candidate: null,
          healed: false,
          notes: ["sidecar skipped"],
        },
      ],
      sidecar_used: false,
    },
    ...overrides,
  };
}

describe("fill outcomes privacy helpers (UNIT_CONFIRMED)", () => {
  it("redacts email, phone, work_auth", () => {
    expect(redactOutcomeValue("skale1@jh.edu", "email")).toMatch(/\*\*\*/);
    expect(redactOutcomeValue("skale1@jh.edu", "email")).not.toContain("skale1");
    expect(redactOutcomeValue("410-555-7636", "phone")).toMatch(/\*\*\*/);
    expect(redactOutcomeValue("Yes", "work_authorization")).toBe(
      "[REDACTED_SPONSORSHIP]",
    );
    expect(redactOutcomeValue("Johns Hopkins University", "school")).toBe(
      "Johns Hopkins University",
    );
  });

  it("classifies dial codes and yes/no", () => {
    expect(classifyValue("+1", "address.country")).toBe("dial_code");
    expect(classifyValue("Yes", "work_authorization")).toBe("work_auth");
    expect(classifyValue("Yes", "other")).toBe("yes_no");
  });

  it("PII fingerprints do not encode the clear value", () => {
    const a = valueFingerprint("skale1@jh.edu", "email");
    const b = valueFingerprint("other@example.com", "email");
    expect(a).toBe(b); // class-only
    expect(valueFingerprint("Mathematics", "major")).not.toBe(
      valueFingerprint("Biology", "major"),
    );
  });
});

describe("buildFillFieldOutcomes (UNIT_CONFIRMED)", () => {
  it("maps synthetic report: redaction, heal status, major synonym pick", () => {
    const rows = buildFillFieldOutcomes("run-1", syntheticInput());
    expect(rows.length).toBe(7);

    const email = rows.find((r) => r.field_id === "email")!;
    expect(email.expected_redacted).not.toContain("skale1@jh.edu");
    expect(email.expected_redacted).toMatch(/@jh\.edu|@|REDACTED/);
    expect(email.verify_match).toBe(1);

    const country = rows.find((r) => r.field_id === "country")!;
    expect(country.verify_match).toBe(0);
    expect(country.heal_status).toBe("still_failing");
    expect(country.observed_class).toBe("dial_code");
    expect(country.selected_option).toBe("United States");
    expect(country.match_basis).toBe("mismatch");

    const major = rows.find((r) => r.field_id === "discipline--0")!;
    expect(major.verify_match).toBe(1);
    expect(major.selected_option).toBe("Mathematics");
    expect(major.match_basis).toBe("unique_substring");
    expect(JSON.parse(major.options_sample_json ?? "[]")).toContain(
      "Mathematics",
    );

    const phone = rows.find((r) => r.field_id === "phone")!;
    expect(phone.expected_redacted).toMatch(/\*\*\*/);
    expect(phone.observed_redacted).toMatch(/\*\*\*/);
    expect(phone.heal_status).toBe("still_failing");

    const auth = rows.find((r) => r.canonical_field === "work_authorization")!;
    expect(auth.expected_redacted).toBe("[REDACTED_SPONSORSHIP]");

    const gender = rows.find((r) => r.field_id === "gender")!;
    expect(gender.match_basis).toBe("skipped");
    expect(gender.fill_ok).toBeNull();
  });
});

describe("recordFillRun SQLite (UNIT_CONFIRMED)", () => {
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    dbPath = path.join(
      os.tmpdir(),
      `fill-outcomes-test-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
    );
    db = openDatabase(dbPath);
    migrate(db);
  });

  afterEach(() => {
    closeDatabase(db);
    try {
      fs.unlinkSync(dbPath);
      fs.unlinkSync(`${dbPath}-wal`);
      fs.unlinkSync(`${dbPath}-shm`);
    } catch {
      // ignore
    }
  });

  it("appends runs and export/summary query results", () => {
    const r1 = recordFillRun(syntheticInput(), { db });
    expect(r1?.fill_run_id).toBeTruthy();
    const r2 = recordFillRun(
      syntheticInput({
        validation_level: "LIVE_MUTATION_CONFIRMED",
        verify: {
          passed: true,
          fields: [
            {
              canonical_field: "legal_name.first",
              expected: "Shubham",
              observed: "Shubham",
              match: true,
            },
          ],
          uploads: [],
          warnings: [],
        },
        heal: null,
      }),
      { db },
    );
    expect(r2?.fill_run_id).toBeTruthy();
    expect(r1?.fill_run_id).not.toBe(r2?.fill_run_id);

    const runCount = (
      db.prepare("SELECT COUNT(*) AS n FROM fill_runs").get() as { n: number }
    ).n;
    expect(runCount).toBe(2);

    const resume = db
      .prepare(
        "SELECT upload_resume_verified FROM fill_runs WHERE id = ?",
      )
      .get(r1!.fill_run_id) as { upload_resume_verified: number };
    expect(resume.upload_resume_verified).toBe(1);

    const summary = summarizeFillOutcomes(db);
    expect(summary.run_count).toBe(2);
    expect(summary.field_outcome_count).toBeGreaterThan(5);
    expect(summary.top_failing_labels.some((x) => x.label === "Country")).toBe(
      true,
    );

    const exported = exportFillOutcomesJsonl(db);
    expect(exported.length).toBeGreaterThan(5);
    const emailRows = exported.filter((r) => r.field_id === "email");
    for (const row of emailRows) {
      const red = String(row.expected_redacted ?? "");
      expect(red).not.toMatch(/^skale1@/);
      expect(red).not.toContain("skale1@jh.edu");
    }

    // plan_only skipped by default
    const planOnly = recordFillRun(
      syntheticInput({ mode: "plan_only", mutation_attempted: false }),
      { db },
    );
    expect(planOnly).toBeNull();
  });
});
