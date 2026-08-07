import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigCache } from "../../src/config/index.js";
import { validateGreenhouseApplicationUrl } from "../../src/ats/greenhouse/urlValidation.js";
import {
  detectClosedJobSignals,
  verifyGreenhousePageIdentity,
} from "../../src/ats/greenhouse/identityVerification.js";
import { verifyFinalNavigation } from "../../src/ats/greenhouse/finalNavigation.js";
import { detectLoginWall } from "../../src/ats/greenhouse/loginWallDetection.js";
import { detectBlockingCaptcha } from "../../src/ats/greenhouse/captchaDetection.js";
import {
  GreenhouseLiveFillError,
  runGreenhouseLiveFill,
} from "../../src/ats/greenhouse/liveFill.js";
import { buildProposedFillPlan } from "../../src/ats/greenhouse/proposedFillPlan.js";
import {
  GreenhouseLiveInspectError,
  inspectGreenhouseApplication,
  type GreenhouseLiveInspectReport,
} from "../../src/ats/greenhouse/liveInspect.js";
import { assertReadOnlyInspectionAllowed } from "../../src/applications/readOnlyInspectionGuards.js";
import type { MappedField } from "../../src/applications/fieldNormalization.js";
import { inspectJobRightControlVisibility } from "../../src/jobright/controlVisibility.js";
import type { Page } from "playwright";
import {
  inspectStoredJobrightJob,
} from "../../src/jobright/inspectStoredJob.js";
import { openDatabase, closeDatabase, migrate } from "../../src/storage/db/client.js";
import { createApplication } from "../../src/queue/stateMachine.js";

const greenhouseFixture = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "ats",
  "greenhouse",
  "dom.sanitized.html",
);
const essayFixture = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "ats",
  "essay",
  "dom.sanitized.html",
);
const demographicsFixture = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "ats",
  "demographics",
  "dom.sanitized.html",
);

function forceSafeEnv(): void {
  process.env.FORM_FILL_ENABLED = "false";
  process.env.DRY_RUN = "true";
  process.env.SUBMIT_ENABLED = "false";
  resetConfigCache();
}

function mapped(
  partial: Partial<MappedField> & Pick<MappedField, "id" | "label" | "type">,
): MappedField {
  return {
    required: false,
    canonical_field: null,
    mapping_confidence: "none",
    ...partial,
  };
}

describe("Phase 5.6A apply-control clarity (UNIT_CONFIRMED)", () => {
  it("reports autofill without claiming standard Apply", async () => {
    const makeLocator = (visible: boolean, text: string | null = null) => {
      const loc = {
        first: () => loc,
        textContent: async () => text,
        isVisible: async () => visible,
        isDisabled: async () => false,
        getAttribute: async () => null,
        count: async () => (visible ? 1 : 0),
        innerText: async () => "body",
      };
      return loc;
    };

    const page = {
      url: () => "https://jobright.ai/jobs/info/abc",
      title: async () => "t",
      locator: () => makeLocator(false),
      getByRole: (_role: string, opts?: { name?: RegExp }) => {
        const re = opts?.name;
        if (re?.test("Apply with Autofill") && !re.test("Apply Only")) {
          // apply-with-autofill pattern matches "Apply with Autofill"
          if (/autofill/i.test(re.source)) {
            return makeLocator(true, "Apply with Autofill");
          }
        }
        if (re && re.test("Apply") && !re.test("Apply with Autofill")) {
          return makeLocator(false);
        }
        return makeLocator(false);
      },
    } as unknown as Page;

    // probeApplyLauncher also uses getByRole apply with autofill
    const v = await inspectJobRightControlVisibility(page);
    expect(v.standard_apply_visible).toBe(false);
    expect(v.apply_with_autofill_visible).toBe(true);
    expect(v.any_apply_control_visible).toBe(true);
    expect(v.details.standard_apply?.visible).toBe(false);
    expect(v.details.apply_with_autofill?.visible).toBe(true);
    expect(v).not.toHaveProperty("apply_cta_visible");
  });
});

describe("Phase 5.6A artifact_path (FIXTURE_CONFIRMED)", () => {
  let dbPath: string;
  let artifactsDir: string;
  const STORED_ID = "aabbccddeeff001122334455";
  const detailFixture = path.join(
    process.cwd(),
    "tests",
    "fixtures",
    "jobright",
    "job-detail",
    "dom.sanitized.html",
  );

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `jaa-artpath-${randomUUID()}.sqlite`);
    artifactsDir = path.join(os.tmpdir(), `jaa-artpath-art-${randomUUID()}`);
    process.env.DATABASE_PATH = dbPath;
    process.env.ARTIFACTS_DIR = artifactsDir;
    forceSafeEnv();
  });

  afterEach(() => {
    resetConfigCache();
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  });

  it("persists artifact_path matching the saved file", async () => {
    const db = openDatabase(dbPath);
    migrate(db);
    const jobDbId = randomUUID();
    const now = new Date().toISOString();
    const jobUrl = `https://jobright.ai/jobs/info/${STORED_ID}`;
    db.prepare(
      `INSERT INTO jobs (
        id, jobright_job_id, normalized_application_url, company, role,
        job_fingerprint, raw_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      jobDbId,
      STORED_ID,
      jobUrl.toLowerCase(),
      "Amazon",
      "Software Development Engineer Internship - Fall 2026 (US)",
      `fp-${STORED_ID}`,
      JSON.stringify({
        job_url: jobUrl,
        jobright_job_id: STORED_ID,
      }),
      now,
      now,
    );
    createApplication(db, { jobId: jobDbId });

    try {
      const report = await inspectStoredJobrightJob({
        jobrightJobId: STORED_ID,
        fixtureDetailHtmlPath: detailFixture,
        headless: true,
        db,
      });
      expect(report.artifact_path).toBeTruthy();
      expect(fs.existsSync(report.artifact_path!)).toBe(true);
      const disk = JSON.parse(
        fs.readFileSync(report.artifact_path!, "utf8"),
      ) as { artifact_path: string | null };
      expect(disk.artifact_path).toBe(report.artifact_path);
      expect(disk.artifact_path).not.toBeNull();
    } finally {
      closeDatabase(db);
    }
  }, 30_000);
});

describe("Greenhouse URL validation (UNIT_CONFIRMED)", () => {
  it("accepts boards.greenhouse.io job URL", () => {
    const r = validateGreenhouseApplicationUrl(
      "https://boards.greenhouse.io/acme/jobs/12345",
    );
    expect(r.passed).toBe(true);
    expect(r.greenhouseJobId).toBe("12345");
    expect(r.boardToken).toBe("acme");
  });

  it("accepts job-boards.greenhouse.io with matching gh_jid", () => {
    const r = validateGreenhouseApplicationUrl(
      "https://job-boards.greenhouse.io/acme/jobs/999?gh_jid=999",
    );
    expect(r.passed).toBe(true);
    expect(r.greenhouseJobId).toBe("999");
  });

  it("rejects HTTP", () => {
    expect(
      validateGreenhouseApplicationUrl(
        "http://boards.greenhouse.io/acme/jobs/1",
      ).passed,
    ).toBe(false);
  });

  it("rejects external host", () => {
    expect(
      validateGreenhouseApplicationUrl(
        "https://boards.lever.co/acme/jobs/1",
      ).passed,
    ).toBe(false);
  });

  it("rejects Greenhouse homepage", () => {
    expect(
      validateGreenhouseApplicationUrl("https://boards.greenhouse.io/").passed,
    ).toBe(false);
  });

  it("rejects mismatched gh_jid", () => {
    expect(
      validateGreenhouseApplicationUrl(
        "https://boards.greenhouse.io/acme/jobs/123?gh_jid=999",
      ).passed,
    ).toBe(false);
  });

  it("rejects javascript and data schemes", () => {
    expect(
      validateGreenhouseApplicationUrl("javascript:alert(1)").passed,
    ).toBe(false);
    expect(validateGreenhouseApplicationUrl("data:text/html,x").passed).toBe(
      false,
    );
  });

  it("rejects unexpected port", () => {
    expect(
      validateGreenhouseApplicationUrl(
        "https://boards.greenhouse.io:8443/acme/jobs/1",
      ).passed,
    ).toBe(false);
  });

  it("accepts JobRight embed job_app URLs (?for= + ?token=)", () => {
    const r = validateGreenhouseApplicationUrl(
      "https://job-boards.greenhouse.io/embed/job_app?for=thenuclearcompany&jr_id=abc&token=5383171008&utm_source=jobright",
    );
    expect(r.passed).toBe(true);
    expect(r.boardToken).toBe("thenuclearcompany");
    expect(r.greenhouseJobId).toBe("5383171008");
    expect(r.normalizedUrl).toBe(
      "https://job-boards.greenhouse.io/thenuclearcompany/jobs/5383171008",
    );
    expect(r.warnings).toContain("embed_job_app_url");
  });

  it("rejects embed without token", () => {
    expect(
      validateGreenhouseApplicationUrl(
        "https://job-boards.greenhouse.io/embed/job_app?for=acme",
      ).passed,
    ).toBe(false);
  });
});

describe("Greenhouse identity (UNIT_CONFIRMED)", () => {
  const noLogin = {
    detected: false as const,
    confidence: "LOW" as const,
    signals: [] as string[],
  };
  const base = {
    requestedUrl: "https://boards.greenhouse.io/acme/jobs/12345",
    finalUrl: "https://boards.greenhouse.io/acme/jobs/12345",
    requestedJobId: "12345",
    observedJobId: "12345",
    company: "acme",
    role: "Intern",
    formDetected: true,
    fieldCount: 5,
    captchaDetected: false,
    loginWall: noLogin,
    closedJobDetected: false,
    errorPageDetected: false,
  };

  it("valid form passes", () => {
    expect(verifyGreenhousePageIdentity(base).passed).toBe(true);
  });

  it("missing form fails", () => {
    const r = verifyGreenhousePageIdentity({
      ...base,
      formDetected: false,
      fieldCount: 0,
    });
    expect(r.passed).toBe(false);
    expect(r.failureCode).toBe("FORM_NOT_FOUND");
  });

  it("CAPTCHA fails", () => {
    const r = verifyGreenhousePageIdentity({
      ...base,
      captchaDetected: true,
    });
    expect(r.passed).toBe(false);
    expect(r.failureCode).toBe("CAPTCHA");
  });

  it("high-confidence login wall fails", () => {
    const r = verifyGreenhousePageIdentity({
      ...base,
      loginWall: {
        detected: true,
        confidence: "HIGH",
        signals: ["password_input_visible_in_dom", "sign_in_heading_or_title"],
      },
    });
    expect(r.passed).toBe(false);
    expect(r.failureCode).toBe("LOGIN_WALL");
  });

  it("medium-confidence login text does not fail as login wall", () => {
    const r = verifyGreenhousePageIdentity({
      ...base,
      loginWall: {
        detected: false,
        confidence: "MEDIUM",
        signals: ["sign_in_heading_or_title"],
      },
    });
    expect(r.passed).toBe(true);
    expect(r.warnings.some((w) => w.includes("login_wall_medium"))).toBe(true);
  });

  it("closed job fails", () => {
    const r = verifyGreenhousePageIdentity({
      ...base,
      closedJobDetected: true,
    });
    expect(r.passed).toBe(false);
    expect(r.failureCode).toBe("APPLICATION_CLOSED");
  });

  it("zero fields fails", () => {
    expect(
      verifyGreenhousePageIdentity({ ...base, fieldCount: 0 }).passed,
    ).toBe(false);
  });

  it("detects closed job signals", () => {
    expect(detectClosedJobSignals("This job is no longer available", "")).toBe(
      true,
    );
  });
});

describe("Greenhouse blocking-CAPTCHA detection (UNIT_CONFIRMED)", () => {
  const dormantFixture = path.join(
    process.cwd(),
    "tests",
    "fixtures",
    "ats",
    "greenhouse",
    "captcha-dormant-recaptcha.html",
  );
  const interstitialFixture = path.join(
    process.cwd(),
    "tests",
    "fixtures",
    "ats",
    "greenhouse",
    "captcha-blocking-interstitial.html",
  );

  it("dormant reCAPTCHA script + v3 badge on a readable form is not blocking", () => {
    const html = fs.readFileSync(dormantFixture, "utf8");
    const r = detectBlockingCaptcha({
      finalUrl: "https://boards.greenhouse.io/acme/jobs/12345",
      html,
      title: "Software Engineer Intern — Acme",
      formDetected: true,
      fieldCount: 5,
    });
    expect(r.detected).toBe(false);
    expect(r.confidence).not.toBe("HIGH");
    expect(r.dormantMarkers).toContain("recaptcha_api_script_loaded");
    expect(r.dormantMarkers).toContain("recaptcha_v3_badge");
  });

  it("Cloudflare interstitial with no readable form is HIGH", () => {
    const html = fs.readFileSync(interstitialFixture, "utf8");
    const r = detectBlockingCaptcha({
      finalUrl: "https://boards.greenhouse.io/acme/jobs/12345",
      html,
      title: "Just a moment...",
      formDetected: false,
      fieldCount: 0,
    });
    expect(r.detected).toBe(true);
    expect(r.confidence).toBe("HIGH");
    expect(r.signals).toContain("no_readable_form_behind_challenge");
  });

  it("the bare word captcha is never enough on its own", () => {
    const r = detectBlockingCaptcha({
      finalUrl: "https://boards.greenhouse.io/acme/jobs/12345",
      html: '<form id="application_form"><input name="captcha_token" type="hidden"/><input id="a" name="a"/></form>',
      formDetected: true,
      fieldCount: 1,
    });
    expect(r.detected).toBe(false);
    expect(r.signals).toEqual([]);
    expect(r.dormantMarkers).toContain("generic_captcha_word_only");
  });

  it("an explicit solve-this prompt with a rendered widget still blocks", () => {
    const html = fs.readFileSync(
      path.join(
        process.cwd(),
        "tests",
        "fixtures",
        "ats",
        "captcha",
        "dom.sanitized.html",
      ),
      "utf8",
    );
    const r = detectBlockingCaptcha({
      finalUrl: "https://boards.greenhouse.io/acme/jobs/captcha-1",
      html,
      title: "Captcha wall",
      formDetected: true,
      fieldCount: 1,
    });
    expect(r.detected).toBe(true);
    expect(r.confidence).toBe("HIGH");
  });
});

describe("Greenhouse proposed fill plan (UNIT_CONFIRMED)", () => {
  it("classifies deterministic, sponsorship, essay, demographic, file, consent, unknown", () => {
    const plan = buildProposedFillPlan([
      mapped({
        id: "1",
        label: "First name",
        type: "text",
        canonical_field: "legal_name.first",
        mapping_confidence: "high",
      }),
      mapped({
        id: "2",
        label: "Will you require sponsorship?",
        type: "select",
        canonical_field: "requires_sponsorship",
        mapping_confidence: "high",
      }),
      mapped({
        id: "3",
        label: "Why do you want to work here?",
        type: "textarea",
      }),
      mapped({
        id: "4",
        label: "Gender",
        type: "select",
      }),
      mapped({
        id: "5",
        label: "Resume",
        type: "file",
      }),
      mapped({
        id: "6",
        label: "I agree to the privacy policy",
        type: "checkbox",
      }),
      mapped({
        id: "7",
        label: "Custom widget xyz",
        type: "text",
      }),
    ]);

    expect(plan.entries.find((e) => e.field_id === "1")?.proposed_action).toBe(
      "FILL_CANDIDATE",
    );
    expect(
      plan.entries.find((e) => e.field_id === "2")?.proposed_action,
    ).toBe("REVIEW_REQUIRED");
    expect(
      plan.entries.find((e) => e.field_id === "3")?.proposed_action,
    ).toBe("SKIP_ESSAY");
    expect(
      plan.entries.find((e) => e.field_id === "4")?.proposed_action,
    ).toBe("SKIP_DEMOGRAPHIC");
    expect(
      plan.entries.find((e) => e.field_id === "5")?.proposed_action,
    ).toBe("UPLOAD_CANDIDATE");
    expect(
      plan.entries.find((e) => e.field_id === "6")?.proposed_action,
    ).toBe("REVIEW_REQUIRED");
    expect(
      plan.entries.find((e) => e.field_id === "7")?.proposed_action,
    ).toBe("REVIEW_REQUIRED");

    for (const e of plan.entries) {
      expect(JSON.stringify(e)).not.toMatch(/@example\.com|555-0100/);
      expect(e).not.toHaveProperty("value");
    }
  });
});

describe("Phase 5.6I guarded live fill (UNIT_CONFIRMED)", () => {
  beforeEach(() => {
    process.env.ARTIFACTS_DIR = path.join(
      os.tmpdir(),
      `jaa-live-fill-${randomUUID()}`,
    );
    forceSafeEnv();
  });

  afterEach(() => {
    forceSafeEnv();
  });

  it("refuses a non-Greenhouse URL before opening a browser", async () => {
    await expect(
      runGreenhouseLiveFill({
        url: "https://boards.lever.co/acme/jobs/1",
        execute: false,
      }),
    ).rejects.toBeInstanceOf(GreenhouseLiveFillError);
  });

  it("refuses --execute while flags are read-only, before opening a browser", async () => {
    // forceSafeEnv leaves FORM_FILL_ENABLED=false and DRY_RUN=true.
    await expect(
      runGreenhouseLiveFill({
        url: "https://boards.greenhouse.io/acme/jobs/12345",
        execute: true,
      }),
    ).rejects.toThrow(/FORM_FILL_ENABLED=false/);
  });

  it("records the refusal in a report rather than only throwing", async () => {
    try {
      await runGreenhouseLiveFill({
        url: "https://boards.lever.co/acme/jobs/1",
        execute: false,
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      const report = (err as GreenhouseLiveFillError).report;
      expect(report.failure_code).toBe("UNSAFE_FINAL_URL");
      expect(report.mutation_attempted).toBe(false);
      expect(report.validation_level).toBe("UNVERIFIED");
      expect(report.submit_attempted).toBe(false);
    }
  });
});

describe("Greenhouse read-only guard (UNIT_CONFIRMED)", () => {
  afterEach(() => {
    forceSafeEnv();
  });

  it("allows only safe flags", () => {
    forceSafeEnv();
    expect(() =>
      assertReadOnlyInspectionAllowed("test"),
    ).not.toThrow();
  });

  it("refuses FORM_FILL_ENABLED=true", () => {
    process.env.FORM_FILL_ENABLED = "true";
    process.env.DRY_RUN = "true";
    process.env.SUBMIT_ENABLED = "false";
    resetConfigCache();
    expect(() => assertReadOnlyInspectionAllowed("test")).toThrow(
      /unsafe environment flags/,
    );
  });

  it("refuses DRY_RUN=false", () => {
    process.env.FORM_FILL_ENABLED = "false";
    process.env.DRY_RUN = "false";
    process.env.SUBMIT_ENABLED = "false";
    resetConfigCache();
    expect(() => assertReadOnlyInspectionAllowed("test")).toThrow(
      /unsafe environment flags/,
    );
  });

  it("refuses SUBMIT_ENABLED=true", () => {
    process.env.FORM_FILL_ENABLED = "false";
    process.env.DRY_RUN = "true";
    process.env.SUBMIT_ENABLED = "true";
    resetConfigCache();
    expect(() => assertReadOnlyInspectionAllowed("test")).toThrow(
      /unsafe environment flags/,
    );
  });
});

describe("Greenhouse fixture inspection (FIXTURE_CONFIRMED)", () => {
  let artifactsDir: string;

  beforeEach(() => {
    artifactsDir = path.join(os.tmpdir(), `jaa-gh-insp-${randomUUID()}`);
    process.env.ARTIFACTS_DIR = artifactsDir;
    forceSafeEnv();
  });

  afterEach(() => {
    resetConfigCache();
  });

  it("inspects greenhouse fixture without mutation", async () => {
    const html = fs.readFileSync(greenhouseFixture, "utf8");
    const report: GreenhouseLiveInspectReport =
      await inspectGreenhouseApplication({
        url: "https://boards.greenhouse.io/acme/jobs/12345",
        fixtureHtml: html,
        headless: true,
      });

    expect(report.validation_level).toBe("FIXTURE_CONFIRMED");
    expect(report.ats).toBe("greenhouse");
    expect(report.mutation_attempted).toBe(false);
    expect(report.upload_attempted).toBe(false);
    expect(report.submit_attempted).toBe(false);
    expect(report.identity_verification?.passed).toBe(true);
    expect(report.field_summary?.deterministic).toBeGreaterThan(0);
    expect(report.field_summary?.sponsorship).toBeGreaterThan(0);
    expect(report.field_summary?.file_upload).toBeGreaterThan(0);
    expect(report.artifact_path).toBeTruthy();
    const disk = JSON.parse(
      fs.readFileSync(report.artifact_path!, "utf8"),
    ) as GreenhouseLiveInspectReport;
    expect(disk.artifact_path).toBe(report.artifact_path);
    expect(JSON.stringify(disk)).not.toMatch(/FIRST|LAST|y\*\*\*/);
  }, 30_000);

  it("sanitizes prefilled values and token-like query from artifact", async () => {
    const dirty = fs
      .readFileSync(greenhouseFixture, "utf8")
      .replace(
        'name="job_application[email]" type="email" required',
        'name="job_application[email]" type="email" required value="secret.candidate@example.com"',
      );
    const report = await inspectGreenhouseApplication({
      url: "https://boards.greenhouse.io/acme/jobs/12345?access_token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaaa",
      fixtureHtml: dirty,
    });
    expect(report.validation_level).toBe("FIXTURE_CONFIRMED");
    const raw = fs.readFileSync(report.artifact_path!, "utf8");
    expect(raw).not.toContain("secret.candidate@example.com");
    expect(raw).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    const emailEntry = report.fields.find((f) =>
      /email/i.test(f.label),
    );
    expect(emailEntry?.prefilled_value_present).toBe(true);
  }, 30_000);

  it("fails closed on captcha fixture identity", async () => {
    const captchaHtml = fs.readFileSync(
      path.join(
        process.cwd(),
        "tests",
        "fixtures",
        "ats",
        "captcha",
        "dom.sanitized.html",
      ),
      "utf8",
    );
    await expect(
      inspectGreenhouseApplication({
        url: "https://boards.greenhouse.io/acme/jobs/12345",
        fixtureHtml: captchaHtml,
      }),
    ).rejects.toThrow(/CAPTCHA|not a verified Greenhouse|Inspection/i);
  }, 30_000);

  it("inspects a form carrying dormant CAPTCHA assets instead of aborting", async () => {
    const html = fs.readFileSync(
      path.join(
        process.cwd(),
        "tests",
        "fixtures",
        "ats",
        "greenhouse",
        "captcha-dormant-recaptcha.html",
      ),
      "utf8",
    );
    const report = await inspectGreenhouseApplication({
      url: "https://boards.greenhouse.io/acme/jobs/12345",
      fixtureHtml: html,
    });
    expect(report.validation_level).toBe("FIXTURE_CONFIRMED");
    expect(report.captcha_detected).toBe(false);
    expect(report.failure_code).toBeNull();
    expect(report.field_count).toBeGreaterThan(0);
    expect(report.captcha_detection?.dormantMarkers).toContain(
      "recaptcha_api_script_loaded",
    );
  }, 30_000);

  it("classifies essay and demographic fixtures", async () => {
    const essayHtml = fs.readFileSync(essayFixture, "utf8");
    const essayReport = await inspectGreenhouseApplication({
      url: "https://boards.greenhouse.io/acme/jobs/12345",
      fixtureHtml: essayHtml,
    });
    expect(essayReport.field_summary?.essay).toBeGreaterThan(0);

    const demoHtml = fs.readFileSync(demographicsFixture, "utf8");
    const demoReport = await inspectGreenhouseApplication({
      url: "https://boards.greenhouse.io/acme/jobs/12345",
      fixtureHtml: demoHtml,
    });
    expect(demoReport.field_summary?.demographic).toBeGreaterThan(0);
  }, 60_000);
});

describe("Greenhouse redirect + login-wall hotfix (FIXTURE_CONFIRMED)", () => {
  let artifactsDir: string;
  const careersFixture = path.join(
    process.cwd(),
    "tests",
    "fixtures",
    "ats",
    "greenhouse",
    "redirect-careers-homepage.html",
  );
  const loginWallFixture = path.join(
    process.cwd(),
    "tests",
    "fixtures",
    "ats",
    "greenhouse",
    "login-wall-high-confidence.html",
  );
  const closedFixture = path.join(
    process.cwd(),
    "tests",
    "fixtures",
    "ats",
    "greenhouse",
    "closed-job.html",
  );

  beforeEach(() => {
    artifactsDir = path.join(os.tmpdir(), `jaa-gh-redir-${randomUUID()}`);
    process.env.ARTIFACTS_DIR = artifactsDir;
    forceSafeEnv();
  });

  afterEach(() => {
    resetConfigCache();
  });

  it("final-host verification rejects employer careers redirect", () => {
    const nav = verifyFinalNavigation({
      requestedUrl: "https://boards.greenhouse.io/okta/jobs/7617090",
      finalUrl: "https://www.okta.com/company/careers/",
    });
    expect(nav.passed).toBe(false);
    expect(nav.failureCode).toBe("GREENHOUSE_APPLICATION_UNAVAILABLE");
    expect(nav.remainedOnTrustedGreenhouseHost).toBe(false);
    expect(nav.redirectObserved).toBe(true);
    expect(nav.finalHost).toBe("www.okta.com");
  });

  it("generic Login nav links are not a login wall", () => {
    const html = fs.readFileSync(careersFixture, "utf8");
    const wall = detectLoginWall({
      finalUrl: "https://www.example.com/careers/",
      html,
      title: "Careers | Example Corp",
    });
    expect(wall.detected).toBe(false);
    expect(wall.confidence).not.toBe("HIGH");
    expect(wall.signals).toContain("generic_login_nav_ignored");
  });

  it("password + sign-in form is HIGH confidence login wall", () => {
    const html = fs.readFileSync(loginWallFixture, "utf8");
    const wall = detectLoginWall({
      finalUrl: "https://boards.greenhouse.io/acme/login",
      html,
      title: "Sign in — Acme Careers",
    });
    expect(wall.detected).toBe(true);
    expect(wall.confidence).toBe("HIGH");
  });

  it("Okta-style redirect is GREENHOUSE_APPLICATION_UNAVAILABLE not LOGIN_WALL", async () => {
    const html = fs.readFileSync(careersFixture, "utf8");
    let report: GreenhouseLiveInspectReport | undefined;
    try {
      await inspectGreenhouseApplication({
        url: "https://boards.greenhouse.io/okta/jobs/7617090",
        fixtureHtml: html,
        fixtureFinalUrl: "https://www.okta.com/company/careers/",
      });
    } catch (err) {
      expect(err).toBeInstanceOf(GreenhouseLiveInspectError);
      report = (err as GreenhouseLiveInspectError).report;
    }
    expect(report).toBeDefined();
    expect(report!.validation_level).toBe("UNVERIFIED");
    expect(report!.failure_code).toBe("GREENHOUSE_APPLICATION_UNAVAILABLE");
    expect(report!.login_wall_detection?.detected).toBe(false);
    expect(report!.form_detected).toBe(false);
    expect(report!.field_count).toBe(0);
    expect(report!.redirect_observed).toBe(true);
    expect(report!.remained_on_trusted_greenhouse_host).toBe(false);
    expect(report!.final_host).toBe("www.okta.com");
    expect(report!.mutation_attempted).toBe(false);
    expect(report!.error).not.toMatch(/Login wall/i);
    expect(report!.artifact_path).toBeTruthy();
    const disk = JSON.parse(
      fs.readFileSync(report!.artifact_path!, "utf8"),
    ) as GreenhouseLiveInspectReport;
    expect(disk.failure_code).toBe("GREENHOUSE_APPLICATION_UNAVAILABLE");
    expect(disk.login_wall_detection?.detected).toBe(false);
  }, 30_000);

  it("employer page with many login links does not trip login wall when on Greenhouse host", async () => {
    // Same HTML but pretend final URL stayed on Greenhouse (edge case)
    const html = fs.readFileSync(careersFixture, "utf8");
    await expect(
      inspectGreenhouseApplication({
        url: "https://boards.greenhouse.io/acme/jobs/12345",
        fixtureHtml: html,
        fixtureFinalUrl: "https://boards.greenhouse.io/acme/jobs/12345",
      }),
    ).rejects.toThrow(/form|fields|Greenhouse/i);
  }, 30_000);

  it("high-confidence login wall on trusted host fails as LOGIN_WALL", async () => {
    const html = fs.readFileSync(loginWallFixture, "utf8");
    let report: GreenhouseLiveInspectReport | undefined;
    try {
      await inspectGreenhouseApplication({
        url: "https://boards.greenhouse.io/acme/jobs/12345",
        fixtureHtml: html,
        fixtureFinalUrl: "https://boards.greenhouse.io/acme/login",
      });
    } catch (err) {
      report = (err as GreenhouseLiveInspectError).report;
    }
    expect(report?.failure_code).toBe("LOGIN_WALL");
    expect(report?.login_wall_detection?.detected).toBe(true);
    expect(report?.login_wall_detection?.confidence).toBe("HIGH");
  }, 30_000);

  it("untrusted final host wins over password fields on employer page", async () => {
    const html = fs.readFileSync(loginWallFixture, "utf8");
    let report: GreenhouseLiveInspectReport | undefined;
    try {
      await inspectGreenhouseApplication({
        url: "https://boards.greenhouse.io/acme/jobs/12345",
        fixtureHtml: html,
        fixtureFinalUrl: "https://www.example.com/careers/login",
      });
    } catch (err) {
      report = (err as GreenhouseLiveInspectError).report;
    }
    expect(report?.failure_code).toBe("GREENHOUSE_APPLICATION_UNAVAILABLE");
    expect(report?.login_wall_detection?.detected).toBe(false);
  }, 30_000);

  it("closed Greenhouse job (still on host) fails APPLICATION_CLOSED", async () => {
    const html = fs.readFileSync(closedFixture, "utf8");
    let report: GreenhouseLiveInspectReport | undefined;
    try {
      await inspectGreenhouseApplication({
        url: "https://boards.greenhouse.io/acme/jobs/12345",
        fixtureHtml: html,
      });
    } catch (err) {
      report = (err as GreenhouseLiveInspectError).report;
    }
    expect(report?.failure_code).toBe("APPLICATION_CLOSED");
  }, 30_000);

  it("valid greenhouse fixture still confirms and is not a login wall", async () => {
    const html = fs.readFileSync(greenhouseFixture, "utf8");
    const report = await inspectGreenhouseApplication({
      url: "https://boards.greenhouse.io/acme/jobs/12345",
      fixtureHtml: html,
    });
    expect(report.validation_level).toBe("FIXTURE_CONFIRMED");
    expect(report.login_wall_detection?.detected).toBe(false);
    expect(report.form_detected).toBe(true);
  }, 30_000);
});
