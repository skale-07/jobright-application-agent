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
import { workableResetForm, workableUploadFile } from "./fill.js";
import { workableSubmit, workableVerifySubmission } from "./submission.js";
import { workableSelectorsV1 } from "./selectors.js";

export { workableSelectorsV1 } from "./selectors.js";
export const WORKABLE_ADAPTER_VERSION = 1;

/**
 * Workable hosted forms — the Tier-1 exemplar adapter (see
 * docs/ats-adapters-lever-ashby.md for the playbook it follows). Separate
 * first/last name fields, so no full-name composition; the generic fill
 * executor handles the native controls. Selectors are UNVERIFIED_SELECTOR
 * until the first live capture promotes them.
 */
export class WorkableAdapterV1 implements ApplicationAdapter {
  readonly id = "workable";
  readonly version = WORKABLE_ADAPTER_VERSION;

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

  setApprovedFillPlan(plan: ApprovedFillPlan): void {
    this.approvedPlan = plan;
  }

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
    if (/apply\.workable\.com|[a-z0-9-]+\.workable\.com\/j\//i.test(input.url)) {
      score += 0.6;
      evidence.push("workable URL host");
    }
    if (workableSelectorsV1.formMarkers.test(input.html)) {
      score += 0.3;
      evidence.push("workable form markers");
    }
    if (/workable\.com|powered by workable/i.test(input.html)) {
      score += 0.2;
      evidence.push("workable branding text");
    }
    return {
      matched: score >= 0.5,
      confidence: Math.min(1, score),
      atsId: this.id,
      evidence,
    };
  }

  async discoverFields(input: { html: string }): Promise<DiscoveredField[]> {
    return discoverFieldsFromHtml(input.html);
  }

  async fill(
    page: Page,
    resolvedAnswers: ResolvedApplicationAnswers,
  ): Promise<FillResult> {
    assertFormFillAllowed("workable.fill");
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
    return workableUploadFile(page, "resume", resumePath);
  }

  async resetForm(page: Page): Promise<FormResetResult> {
    return workableResetForm(page);
  }

  async submit(page: Page): Promise<SubmissionAttempt> {
    return workableSubmit(page);
  }

  async verifySubmission(page: Page): Promise<SubmissionReceipt> {
    const screenshotPath = path.join(
      getConfig().artifactsDir,
      "ats-submit",
      "workable",
      `receipt-${Date.now()}.png`,
    );
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    return workableVerifySubmission(page, { screenshotPath });
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
      loginWall.detected || workableSelectorsV1.loginMarkers.test(input.html);
    const captcha = detectBlockingCaptcha({
      finalUrl: input.url,
      html: input.html,
      ...(input.title ? { title: input.title } : {}),
      formDetected: workableSelectorsV1.formMarkers.test(input.html),
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
