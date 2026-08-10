import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import type {
  ApplicationAdapter,
  ApplicationInspection,
  DetectionResult,
  DiscoveredField,
  FillResult,
  FormResetResult,
  FormVerificationResult,
  ResolvedApplicationAnswers,
  SubmissionAttempt,
  SubmissionReceipt,
  UploadVerification,
} from "../adapter.js";
import { getConfig } from "../../config/index.js";
import { discoverFieldsFromHtml } from "../../applications/fieldDiscovery.js";
import { applyLeverCardQuestions } from "./cardQuestions.js";
import { assertFormFillAllowed } from "../../applications/formFillGuards.js";
import { detectBlockingCaptcha } from "../greenhouse/captchaDetection.js";
import { detectLoginWall } from "../greenhouse/loginWallDetection.js";
import type { FillPlanEntry } from "../../applications/resolveAnswers.js";
import {
  approvedFillEntries,
  type ApprovedFillPlan,
} from "../../applications/approvedFillPlan.js";
import {
  greenhouseFillFromPlan,
  greenhouseVerifyAnswers,
  type FieldMeta,
} from "../greenhouse/fill.js";
import { leverResetForm, leverUploadFile } from "./fill.js";
import { leverSubmit, leverVerifySubmission } from "./submission.js";
import type { PublicProfile } from "../../candidate/publicProfile.js";
import {
  composeFullName,
  makeFullNameMatcher,
} from "../shared/nameComposition.js";
import { leverSelectorsV1 } from "./selectors.js";

export { leverSelectorsV1 } from "./selectors.js";
export const LEVER_ADAPTER_VERSION = 1;

/**
 * Single full-name field on Lever forms is the input named "name".
 */
export const leverFullNameMatcher = makeFullNameMatcher({
  fieldNames: ["name"],
  labelPattern: /^full[\s_-]?name\b/i,
});

/**
 * Lever postings forms — selectors in ./selectors.ts.
 *
 * NOT WIRED: this adapter is not registered in src/ats/registry.ts and is
 * constructed directly only by its tests. Wiring (registry, filler dispatch,
 * live orchestration) is a future milestone.
 */
export class LeverAdapterV1 implements ApplicationAdapter {
  readonly id = "lever";
  readonly version = LEVER_ADAPTER_VERSION;

  private lastPlanEntries: FillPlanEntry[] = [];
  private lastFieldMeta = new Map<string, FieldMeta>();
  private approvedPlan: ApprovedFillPlan | null = null;

  setFillContext(entries: FillPlanEntry[], fields: DiscoveredField[]): void {
    this.lastPlanEntries = entries;
    this.lastFieldMeta = new Map(
      fields.map((f) => {
        const meta: FieldMeta = { type: f.type };
        if (f.name) meta.name = f.name;
        if (f.inputId) meta.inputId = f.inputId;
        return [f.id, meta] as const;
      }),
    );
  }

  /**
   * Required before fill(). The profile is mandatory so the full-name
   * composition (legal_name.first + legal_name.last → "First Last")
   * cannot be skipped by any caller.
   */
  setApprovedFillPlan(plan: ApprovedFillPlan, profile?: PublicProfile): void {
    // profile is optional only for cross-ATS call-shape parity — Lever
    // cannot fill without it (full-name composition), so fail closed.
    if (!profile) {
      throw new Error(
        "Lever fill requires the public profile for full-name composition — pass profile to setApprovedFillPlan",
      );
    }
    // Resolve field_id (often the input's id) back to its name attribute so
    // the matcher's fieldNames work even when id ≠ name. Requires
    // setFillContext to have run first, as the tests and wiring do.
    this.approvedPlan = composeFullName(
      plan,
      profile,
      leverFullNameMatcher,
      (fieldId) => this.lastFieldMeta.get(fieldId)?.name,
    );
  }

  /** Composed plan as fill() will execute it (test/report visibility). */
  getApprovedFillPlan(): ApprovedFillPlan | null {
    return this.approvedPlan;
  }

  protected requireApprovedPlan(): ApprovedFillPlan {
    if (this.approvedPlan === null) {
      throw new Error(
        "Approved fill plan required — call setApprovedFillPlan before fill(). Direct resolvedAnswers fill is not allowed.",
      );
    }
    return this.approvedPlan;
  }

  protected planEntries(): FillPlanEntry[] {
    return this.lastPlanEntries;
  }

  protected fieldMeta(): Map<string, FieldMeta> {
    return this.lastFieldMeta;
  }

  async detect(input: {
    url: string;
    html: string;
    title?: string;
  }): Promise<DetectionResult> {
    const evidence: string[] = [];
    let score = 0;
    if (/jobs(?:\.eu)?\.lever\.co/i.test(input.url)) {
      score += 0.6;
      evidence.push("lever URL host");
    }
    if (leverSelectorsV1.formMarkers.test(input.html)) {
      score += 0.3;
      evidence.push("lever form markers");
    }
    if (/jobs(?:\.eu)?\.lever\.co|powered by lever/i.test(input.html)) {
      score += 0.2;
      evidence.push("lever branding text");
    }
    return {
      matched: score >= 0.5,
      confidence: Math.min(1, score),
      atsId: this.id,
      evidence,
    };
  }

  async discoverFields(input: { html: string }): Promise<DiscoveredField[]> {
    // Custom-question cards keep their label in a sibling div, not the
    // input's <label> — overlay the real question text/options/required
    // so the bank, completeness naming, and prediction queue see them.
    return applyLeverCardQuestions(
      discoverFieldsFromHtml(input.html),
      input.html,
    );
  }

  /**
   * Executes only approved FILL entries via the generic executor (locator by
   * inputId → name → label; native-select/combobox/checkbox/radio/text
   * dispatch). Lever forms are native controls throughout.
   */
  async fill(
    page: Page,
    resolvedAnswers: ResolvedApplicationAnswers,
  ): Promise<FillResult> {
    assertFormFillAllowed("lever.fill");
    const plan = this.requireApprovedPlan();
    void resolvedAnswers;
    return greenhouseFillFromPlan(
      page,
      approvedFillEntries(plan),
      this.fieldMeta(),
    );
  }

  async verify(
    page: Page,
    expected: ResolvedApplicationAnswers,
  ): Promise<FormVerificationResult> {
    const entries =
      this.approvedPlan !== null
        ? approvedFillEntries(this.approvedPlan)
        : this.planEntries();
    return greenhouseVerifyAnswers(page, expected, entries, this.fieldMeta());
  }

  async uploadResume(
    page: Page,
    resumePath: string,
  ): Promise<UploadVerification> {
    return leverUploadFile(page, "resume", resumePath);
  }

  async resetForm(page: Page): Promise<FormResetResult> {
    return leverResetForm(page);
  }

  async submit(page: Page): Promise<SubmissionAttempt> {
    return leverSubmit(page);
  }

  async verifySubmission(page: Page): Promise<SubmissionReceipt> {
    const screenshotPath = path.join(
      getConfig().artifactsDir,
      "ats-submit",
      "lever",
      `receipt-${Date.now()}.png`,
    );
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    return leverVerifySubmission(page, { screenshotPath });
  }

  async inspect(input: {
    url: string;
    html: string;
    title?: string;
  }): Promise<ApplicationInspection> {
    const fields = await this.discoverFields({ html: input.html });
    const loginWall = detectLoginWall({
      finalUrl: input.url,
      html: input.html,
      ...(input.title ? { title: input.title } : {}),
    });
    const requires_login =
      loginWall.detected || leverSelectorsV1.loginMarkers.test(input.html);
    const captcha = detectBlockingCaptcha({
      finalUrl: input.url,
      html: input.html,
      ...(input.title ? { title: input.title } : {}),
      formDetected: leverSelectorsV1.formMarkers.test(input.html),
      fieldCount: fields.length,
    });
    const captcha_detected = captcha.detected;
    const account_creation_detected =
      /create (an )?account|sign up to apply/i.test(input.html);

    const warnings: string[] = [];
    if (requires_login) warnings.push("Login wall detected");
    if (captcha_detected) {
      warnings.push(`Blocking CAPTCHA detected: ${captcha.signals.join(",")}`);
    } else if (captcha.dormantMarkers.length > 0) {
      warnings.push(
        `Dormant CAPTCHA markers ignored: ${captcha.dormantMarkers.join(",")}`,
      );
    }
    if (account_creation_detected) {
      warnings.push("Account creation markers detected");
    }

    return {
      ats: this.id,
      adapter_version: this.version,
      url: input.url,
      title: input.title ?? "",
      requires_login,
      captcha_detected,
      account_creation_detected,
      fields,
      warnings,
    };
  }
}
