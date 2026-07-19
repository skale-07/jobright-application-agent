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
  UploadVerification,
} from "../adapter.js";
import { discoverFieldsFromHtml } from "../../applications/fieldDiscovery.js";
import {
  greenhouseFillFromPlan,
  greenhouseRefuseSubmit,
  greenhouseResetForm,
  greenhouseUploadFile,
  greenhouseVerifyAnswers,
  type FieldMeta,
} from "./fill.js";
import type { FillPlanEntry } from "../../applications/resolveAnswers.js";
import {
  approvedFillEntries,
  type ApprovedFillPlan,
} from "../../applications/approvedFillPlan.js";
import { greenhouseSelectorsV1 } from "./selectors.js";

export { greenhouseSelectorsV1 } from "./selectors.js";
export const GREENHOUSE_ADAPTER_VERSION = 1;

/**
 * Greenhouse board forms — selectors in ./selectors.ts
 */

export class GreenhouseAdapterV1 implements ApplicationAdapter {
  readonly id = "greenhouse";
  readonly version = GREENHOUSE_ADAPTER_VERSION;

  /** Last fill plan used — needed for verify when called via adapter API. */
  private lastPlanEntries: FillPlanEntry[] = [];
  private lastFieldMeta = new Map<string, FieldMeta>();
  private approvedPlan: ApprovedFillPlan | null = null;

  setFillContext(
    entries: FillPlanEntry[],
    fields: DiscoveredField[],
  ): void {
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
   * Required before fill(). Only approved FILL entries are executed.
   */
  setApprovedFillPlan(plan: ApprovedFillPlan): void {
    this.approvedPlan = plan;
  }

  async detect(input: {
    url: string;
    html: string;
    title?: string;
  }): Promise<DetectionResult> {
    const evidence: string[] = [];
    let score = 0;
    if (/boards\.greenhouse\.io|greenhouse\.io|grnh\.se/i.test(input.url)) {
      score += 0.6;
      evidence.push("greenhouse URL host");
    }
    if (/id=["']application_form["']|new_job_application|data-greenhouse/i.test(input.html)) {
      score += 0.3;
      evidence.push("greenhouse form markers");
    }
    if (/powered by greenhouse|greenhouse job board/i.test(input.html)) {
      score += 0.2;
      evidence.push("greenhouse branding text");
    }
    return {
      matched: score >= 0.5,
      confidence: Math.min(1, score),
      atsId: this.id,
      evidence,
    };
  }

  async discoverFields(input: { html: string }): Promise<DiscoveredField[]> {
    return discoverFieldsFromHtml(input.html, { preferGreenhouse: true });
  }

  async inspect(input: {
    url: string;
    html: string;
    title?: string;
  }): Promise<ApplicationInspection> {
    const fields = await this.discoverFields({ html: input.html });
    const requires_login = greenhouseSelectorsV1.loginMarkers.test(input.html);
    const captcha_detected = greenhouseSelectorsV1.captchaMarkers.test(input.html);
    const account_creation_detected =
      /create (an )?account|sign up to apply/i.test(input.html);

    const warnings: string[] = [];
    if (requires_login) warnings.push("Login wall detected");
    if (captcha_detected) warnings.push("CAPTCHA markers detected");
    if (account_creation_detected) warnings.push("Account creation markers detected");

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

  async fill(
    page: Page,
    resolvedAnswers: ResolvedApplicationAnswers,
  ): Promise<FillResult> {
    if (this.approvedPlan === null) {
      throw new Error(
        "Approved fill plan required — call setApprovedFillPlan before fill(). Direct resolvedAnswers fill is not allowed.",
      );
    }
    void resolvedAnswers;
    const entries = approvedFillEntries(this.approvedPlan);
    return greenhouseFillFromPlan(page, entries, this.lastFieldMeta);
  }

  async verify(
    page: Page,
    expected: ResolvedApplicationAnswers,
  ): Promise<FormVerificationResult> {
    const entries =
      this.approvedPlan !== null
        ? approvedFillEntries(this.approvedPlan)
        : this.lastPlanEntries;
    return greenhouseVerifyAnswers(
      page,
      expected,
      entries,
      this.lastFieldMeta,
    );
  }

  async uploadResume(page: Page, resumePath: string): Promise<UploadVerification> {
    return greenhouseUploadFile(page, "resume", resumePath);
  }

  async uploadCoverLetter(
    page: Page,
    coverLetterPath: string,
  ): Promise<UploadVerification> {
    return greenhouseUploadFile(page, "cover_letter", coverLetterPath);
  }

  async resetForm(page: Page): Promise<FormResetResult> {
    return greenhouseResetForm(page);
  }

  async submit(page: Page): Promise<SubmissionAttempt> {
    return greenhouseRefuseSubmit(page);
  }
}
