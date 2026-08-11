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
import { workdayUploadFile, workdayResetForm } from "./fill.js";
import { workdaySubmit, workdayVerifySubmission } from "./submission.js";
import { workdaySelectorsV1 } from "./selectors.js";

export { workdaySelectorsV1 } from "./selectors.js";
export const WORKDAY_ADAPTER_VERSION = 1;

/**
 * Workday hosted career sites (<tenant>.wdN.myworkdayjobs.com) — Tier-2:
 * behind a per-tenant account (see src/verification/portalAuth.ts for the
 * deterministic sign-in / create-account flow) and a multi-page wizard.
 *
 * This adapter fills the My Information page from the approved plan and
 * uploads the resume; pages it does not model (Experience, custom
 * questions, EEO) surface as review items via the pipeline's completeness
 * gate rather than being force-filled. Submit is gated exactly like the
 * other adapters and only clicks the FINAL wizard submit.
 *
 * Selectors are UNVERIFIED_SELECTOR until the first live capture promotes
 * them; the /improve loop heals from the form snapshots.
 */
export class WorkdayAdapterV1 implements ApplicationAdapter {
  readonly id = "workday";
  readonly version = WORKDAY_ADAPTER_VERSION;

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
        "Approved fill plan required — call setApprovedFillPlan before fill().",
      );
    }
    return this.approvedPlan;
  }

  async detect(input: {
    url: string;
    html: string;
    title?: string;
  }): Promise<DetectionResult> {
    const evidence: string[] = [];
    let score = 0;
    if (/\.wd\d+\.myworkdayjobs\.com/i.test(input.url)) {
      score += 0.6;
      evidence.push("workday tenant host");
    }
    if (/data-automation-id=/i.test(input.html)) {
      score += 0.3;
      evidence.push("workday data-automation-id hooks");
    }
    if (/workday/i.test(input.html)) {
      score += 0.1;
      evidence.push("workday branding text");
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
    assertFormFillAllowed("workday.fill");
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
    return workdayUploadFile(page, "resume", resumePath);
  }

  async resetForm(page: Page): Promise<FormResetResult> {
    return workdayResetForm(page);
  }

  async submit(page: Page): Promise<SubmissionAttempt> {
    return workdaySubmit(page);
  }

  async verifySubmission(page: Page): Promise<SubmissionReceipt> {
    const screenshotPath = path.join(
      getConfig().artifactsDir,
      "ats-submit",
      "workday",
      `receipt-${Date.now()}.png`,
    );
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    return workdayVerifySubmission(page, { screenshotPath });
  }

  async inspect(input: {
    url: string;
    html: string;
    title?: string;
  }): Promise<ApplicationInspection> {
    const fields = await this.discoverFields({ html: input.html });
    const auth = workdaySelectorsV1.auth;
    const loginWall = detectLoginWall({
      finalUrl: input.url,
      html: input.html,
      ...(input.title ? { title: input.title } : {}),
    });
    const account_creation_detected =
      auth.createAccountMarkers.test(input.html) ||
      /create (an )?account/i.test(input.html);
    // On Workday, a sign-in / create-account wall is the EXPECTED entry
    // gate — portalAuth handles it — so requires_login flags it for the
    // caller to run auth, not as a dead end.
    const requires_login =
      loginWall.detected || auth.signInMarkers.test(input.html) || account_creation_detected;
    const captcha = detectBlockingCaptcha({
      finalUrl: input.url,
      html: input.html,
      ...(input.title ? { title: input.title } : {}),
      formDetected: /data-automation-id=/i.test(input.html),
      fieldCount: fields.length,
    });

    const warnings: string[] = [];
    if (requires_login) warnings.push("Workday account wall (portalAuth handles sign-in/create)");
    if (account_creation_detected) warnings.push("Account creation markers detected");
    if (captcha.detected) {
      warnings.push(`Blocking CAPTCHA detected: ${captcha.signals.join(",")}`);
    }
    warnings.push(
      "Workday is a multi-page wizard: My Information is auto-filled; other pages route to human review",
    );

    return {
      ats: this.id,
      adapter_version: this.version,
      url: input.url,
      title: input.title ?? "",
      requires_login,
      captcha_detected: captcha.detected,
      account_creation_detected,
      fields,
      warnings,
    };
  }

  protected planEntries(): FillPlanEntry[] {
    return this.lastPlanEntries;
  }

  protected fieldMeta(): Map<string, FieldMeta> {
    return this.lastFieldMeta;
  }
}
