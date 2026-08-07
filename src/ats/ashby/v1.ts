import type {
  ApplicationAdapter,
  ApplicationInspection,
  DetectionResult,
  DiscoveredField,
} from "../adapter.js";
import { assertFormFillAllowed } from "../../applications/formFillGuards.js";
import { detectBlockingCaptcha } from "../greenhouse/captchaDetection.js";
import { detectLoginWall } from "../greenhouse/loginWallDetection.js";
import type { FillPlanEntry } from "../../applications/resolveAnswers.js";
import type { ApprovedFillPlan } from "../../applications/approvedFillPlan.js";
import type { FieldMeta } from "../greenhouse/fill.js";
import type { PublicProfile } from "../../candidate/publicProfile.js";
import {
  composeFullName,
  makeFullNameMatcher,
} from "../shared/nameComposition.js";
import { ashbyDiscoverFields, looksLikeUnrenderedShell } from "./discovery.js";
import { ashbySelectorsV1 } from "./selectors.js";

export { ashbySelectorsV1 } from "./selectors.js";
export const ASHBY_ADAPTER_VERSION = 1;

/** Ashby's single full-name field is the _systemfield_name input. */
export const ashbyFullNameMatcher = makeFullNameMatcher({
  fieldNames: ["_systemfield_name"],
  labelPattern: /^full[\s_-]?name\b/i,
});

/**
 * Ashby application forms — selectors in ./selectors.ts.
 *
 * NOT WIRED: this adapter is not registered in src/ats/registry.ts and is
 * constructed directly only by its tests. Wiring (registry, filler dispatch,
 * live orchestration) is a future milestone.
 */
export class AshbyAdapterV1 implements ApplicationAdapter {
  readonly id = "ashby";
  readonly version = ASHBY_ADAPTER_VERSION;

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
  setApprovedFillPlan(plan: ApprovedFillPlan, profile: PublicProfile): void {
    this.approvedPlan = composeFullName(plan, profile, ashbyFullNameMatcher);
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

  /** Referenced by fill methods arriving in the next milestone. */
  protected assertFillAllowed(reason: string): void {
    assertFormFillAllowed(reason);
  }

  async detect(input: {
    url: string;
    html: string;
    title?: string;
  }): Promise<DetectionResult> {
    const evidence: string[] = [];
    let score = 0;
    if (/jobs\.ashbyhq\.com/i.test(input.url)) {
      score += 0.6;
      evidence.push("ashby URL host");
    }
    if (ashbySelectorsV1.formMarkers.test(input.html)) {
      score += 0.3;
      evidence.push("ashby form markers");
    }
    if (/ashbyhq\.com|powered by ashby|window\.__appData/i.test(input.html)) {
      score += 0.2;
      evidence.push("ashby branding / app shell");
    }
    return {
      matched: score >= 0.5,
      confidence: Math.min(1, score),
      atsId: this.id,
      evidence,
    };
  }

  async discoverFields(input: { html: string }): Promise<DiscoveredField[]> {
    return ashbyDiscoverFields(input.html);
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
      loginWall.detected || ashbySelectorsV1.loginMarkers.test(input.html);
    const captcha = detectBlockingCaptcha({
      finalUrl: input.url,
      html: input.html,
      ...(input.title ? { title: input.title } : {}),
      formDetected: ashbySelectorsV1.formMarkers.test(input.html),
      fieldCount: fields.length,
    });
    const captcha_detected = captcha.detected;
    const account_creation_detected =
      /create (an )?account|sign up to apply/i.test(input.html);

    const warnings: string[] = [];
    if (fields.length === 0 && looksLikeUnrenderedShell(input.html)) {
      warnings.push(
        "Ashby is a SPA — this HTML is an unrendered shell; inspection requires a rendered DOM snapshot (live page or captured post-render)",
      );
    }
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
