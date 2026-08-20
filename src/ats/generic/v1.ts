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
import {
  detectUploadCommit,
  resolveResumeFileInput,
} from "../shared/uploadResolve.js";
import { genericSelectorsV1 } from "./selectors.js";
import { genericSubmit, genericVerifySubmission } from "./submission.js";

export { genericSelectorsV1 } from "./selectors.js";
export const GENERIC_ADAPTER_VERSION = 2;

/**
 * Company-hosted application forms — the long tail.
 *
 * Most employers do not use one of the five hosted ATS products, and in
 * the live corpus every unsupported URL was a different host. This adapter
 * exists so that tail is fillable instead of dead-ended at
 * UNSUPPORTED_ATS.
 *
 * It carries almost no code of its own, because almost nothing in the fill
 * path was ever vendor-specific: field discovery, canonical mapping, plan
 * approval, the field executor (greenhouseFillFromPlan — Workable and
 * Workday already call it verbatim), read-back verification, upload
 * resolution, submit-control resolution and the required-completeness scan
 * are all DOM-generic already. What a vendor registry adds is a product's
 * DOM contract; this adapter substitutes structural heuristics for it and
 * is honest about the one place that costs something (see submission.ts —
 * confirmation requires the form to be structurally gone, not just
 * confirmation text on the page).
 *
 * Human-authored essay answers at submit still require a vendor that
 * supportsEssayFill. Generated about-me essays go through the same
 * greenhouseFillFromPlan path as every other approved text field.
 */
export class GenericAdapterV1 implements ApplicationAdapter {
  readonly id = "generic";
  readonly version = GENERIC_ADAPTER_VERSION;

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

  protected fieldMeta(): Map<string, FieldMeta> {
    return this.lastFieldMeta;
  }

  /**
   * Lowest-confidence detector in the registry by design: it claims any
   * page with fillable controls, and registry.ts asks it LAST so every
   * vendor gets first refusal. A wrapping `<form>` is typical, not
   * required — Paylocity (live 2026-08-19) rendered 32 inputs in a SPA
   * shell; requiring the tag sent detectAts to unsupported and fill threw.
   */
  async detect(input: { url: string; html: string }): Promise<DetectionResult> {
    const fields = discoverFieldsFromHtml(input.html);
    const hasForm = genericSelectorsV1.formMarkers.test(input.html);
    const matched = fields.length > 0 || hasForm;
    return {
      matched,
      confidence: matched ? 0.4 : 0,
      atsId: this.id,
      evidence: matched
        ? [
            fields.length > 0
              ? `generic form with ${fields.length} discoverable field(s)`
              : "form markup present",
          ]
        : ["no form with fillable controls detected"],
    };
  }

  async discoverFields(input: { html: string }): Promise<DiscoveredField[]> {
    return discoverFieldsFromHtml(input.html);
  }

  async fill(
    page: Page,
    resolvedAnswers: ResolvedApplicationAnswers,
  ): Promise<FillResult> {
    assertFormFillAllowed("generic.fill");
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
        : this.lastPlanEntries;
    return greenhouseVerifyAnswers(page, expected, entries, this.fieldMeta());
  }

  async uploadResume(
    page: Page,
    resumePath: string,
  ): Promise<UploadVerification> {
    assertFormFillAllowed("generic.upload.resume");
    const abs = path.resolve(resumePath);
    if (!fs.existsSync(abs)) {
      return {
        field: "resume",
        path: abs,
        filename: path.basename(abs),
        size_bytes: 0,
        verified: false,
        evidence: "file missing",
      };
    }
    const stat = fs.statSync(abs);
    const filename = path.basename(abs);
    // The shared cascade already degrades from a vendor CSS seed to a
    // /resume|cv/i keyword match to a lone file input — exactly what an
    // unknown employer form needs.
    const resolution = await resolveResumeFileInput(page, {
      css: genericSelectorsV1.resume,
    });
    if (!resolution.found) {
      return {
        field: "resume",
        path: abs,
        filename,
        size_bytes: stat.size,
        verified: false,
        evidence: `no file input resolved: ${resolution.notes.join("; ")}`,
      };
    }
    await resolution.input.setInputFiles(abs);
    const commit = await detectUploadCommit(page, resolution.input, {
      filename,
      sizeBytes: stat.size,
    });
    return {
      field: "resume",
      path: abs,
      filename,
      size_bytes: stat.size,
      verified: commit.verified,
      evidence: [...resolution.notes, commit.evidence].join("; "),
    };
  }

  /**
   * No reliable generic reset: an unknown form has no vendor "start over"
   * control, and clearing fields one by one on a page we do not model is
   * how a half-filled application gets submitted. Report honestly.
   */
  async resetForm(page: Page): Promise<FormResetResult> {
    void page;
    return {
      reset: false,
      notes: [
        "generic adapter does not reset unknown forms — reload the page to start over",
      ],
    };
  }

  async submit(page: Page): Promise<SubmissionAttempt> {
    return genericSubmit(page);
  }

  async verifySubmission(page: Page): Promise<SubmissionReceipt> {
    const screenshotPath = path.join(
      getConfig().artifactsDir,
      "ats-submit",
      "generic",
      `receipt-${Date.now()}.png`,
    );
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    return genericVerifySubmission(page, { screenshotPath });
  }

  async inspect(input: {
    url: string;
    html: string;
    title?: string;
  }): Promise<ApplicationInspection> {
    // Callers in the wild have handed inspect an undefined body; a generic
    // adapter is the one most likely to be reached that way, so tolerate it.
    const html = input.html ?? "";
    const fields = await this.discoverFields({ html });
    const loginWall = detectLoginWall({
      finalUrl: input.url,
      html,
      ...(input.title ? { title: input.title } : {}),
    });
    const requires_login =
      loginWall.detected || genericSelectorsV1.loginMarkers.test(html);
    const captcha = detectBlockingCaptcha({
      finalUrl: input.url,
      html,
      ...(input.title ? { title: input.title } : {}),
      formDetected: genericSelectorsV1.formMarkers.test(html),
      fieldCount: fields.length,
    });
    const warnings: string[] = [
      "generic adapter — selectors are structural heuristics, not a vendor DOM contract",
    ];
    if (requires_login) warnings.push("Login wall detected");
    if (captcha.detected) {
      warnings.push(`Blocking CAPTCHA detected: ${captcha.signals.join(",")}`);
    }
    return {
      ats: this.id,
      adapter_version: this.version,
      url: input.url,
      title: input.title ?? "",
      requires_login,
      captcha_detected: captcha.detected,
      account_creation_detected: /create (an )?account|sign up to apply/i.test(html),
      fields,
      warnings,
    };
  }
}
