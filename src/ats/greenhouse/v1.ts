import type {
  ApplicationAdapter,
  ApplicationInspection,
  DetectionResult,
  DiscoveredField,
} from "../adapter.js";
import { discoverFieldsFromHtml } from "../../applications/fieldDiscovery.js";

export const GREENHOUSE_ADAPTER_VERSION = 1;

/**
 * Greenhouse board forms — selectors derived from common public Greenhouse markup
 * plus fixture tests. Prefer #application_form and data attributes over brittle classes.
 */
export const greenhouseSelectorsV1 = {
  form: "#application_form, form#new_job_application, form[action*='greenhouse']",
  fieldContainer: ".field, .application--field, .field--text, .field--textarea",
  requiredMarker: ".required, [aria-required='true'], .asterisk",
  resume: "input[type='file'][name*='resume' i], #resume",
  coverLetter: "input[type='file'][name*='cover' i], #cover_letter",
  submit: "input[type='submit'], button[type='submit']",
  loginMarkers: /sign in|log in|create an account|create account/i,
  captchaMarkers: /captcha|recaptcha|hcaptcha|cf-turnstile/i,
} as const;

export class GreenhouseAdapterV1 implements ApplicationAdapter {
  readonly id = "greenhouse";
  readonly version = GREENHOUSE_ADAPTER_VERSION;

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
}
