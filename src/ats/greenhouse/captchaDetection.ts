/**
 * High-confidence blocking-CAPTCHA detection for Greenhouse inspection.
 *
 * A loaded reCAPTCHA script, a v3 badge, or a bare `data-sitekey` attribute must
 * never stop inspection: Greenhouse pages commonly ship dormant CAPTCHA assets
 * that only arm at submit time. Only a challenge that actually blocks reading
 * the application form aborts.
 */

export type CaptchaConfidence = "HIGH" | "MEDIUM" | "LOW";

export type CaptchaDetection = {
  /** True only at HIGH confidence. */
  detected: boolean;
  confidence: CaptchaConfidence;
  /** Blocking evidence that contributed to the score. */
  signals: string[];
  /** Recorded for diagnostics; never contributes to an abort. */
  dormantMarkers: string[];
};

/** Cloudflare / provider interstitial that replaces the page entirely. */
const INTERSTITIAL_PAGE =
  /__cf_chl|cf-browser-verification|challenge-platform|cdn-cgi\/challenge/i;

const INTERSTITIAL_TITLE =
  /just a moment|checking your browser|attention required|security check/i;

/** A rendered challenge frame, not merely the library being present. */
const CHALLENGE_IFRAME =
  /<iframe[^>]+src=["'][^"']*(?:recaptcha\/api2\/(?:bframe|anchor)|hcaptcha\.com\/captcha|challenges\.cloudflare\.com)[^"']*["']/i;

/** Text that instructs a human to solve something before continuing. */
const HUMAN_PROMPT =
  /verify (?:you are|you're) (?:a )?human|i'?m not a robot|complete the (?:security check|captcha)|unusual traffic from your computer|please complete the captcha|prove you are human/i;

/** Widget containers that are rendered into the DOM. */
const RECAPTCHA_WIDGET = /class=["'][^"']*\bg-recaptcha\b[^"']*["']/i;
const HCAPTCHA_WIDGET = /class=["'][^"']*\bh-captcha\b[^"']*["']/i;
const TURNSTILE_WIDGET = /class=["'][^"']*\bcf-turnstile\b[^"']*["']/i;

/** Dormant markers — presence alone proves nothing. */
const RECAPTCHA_API_SCRIPT =
  /<script[^>]+src=["'][^"']*recaptcha\/(?:api|enterprise)\.js[^"']*["']/i;
const RECAPTCHA_V3_BADGE = /grecaptcha-badge/i;
const GRECAPTCHA_GLOBAL = /\bgrecaptcha\b/i;
const SITEKEY_ATTR = /data-sitekey=/i;
const GENERIC_CAPTCHA_WORD = /captcha/i;

const HIGH_THRESHOLD = 4;
const MEDIUM_THRESHOLD = 2;

/**
 * Detect a CAPTCHA that blocks reading the application form.
 * Returns detected:true only for HIGH confidence.
 */
export function detectBlockingCaptcha(input: {
  finalUrl: string;
  html: string;
  title?: string;
  formDetected?: boolean;
  fieldCount?: number;
}): CaptchaDetection {
  const signals: string[] = [];
  const dormantMarkers: string[] = [];
  const html = input.html.slice(0, 80_000);
  const title = input.title ?? "";

  let score = 0;

  if (INTERSTITIAL_PAGE.test(html) || INTERSTITIAL_PAGE.test(input.finalUrl)) {
    score += 4;
    signals.push("interstitial_challenge_page");
  }
  if (INTERSTITIAL_TITLE.test(title)) {
    score += 4;
    signals.push("interstitial_challenge_title");
  }
  if (CHALLENGE_IFRAME.test(html)) {
    score += 3;
    signals.push("challenge_iframe_rendered");
  }
  if (HUMAN_PROMPT.test(html)) {
    score += 3;
    signals.push("human_verification_prompt");
  }
  if (RECAPTCHA_WIDGET.test(html)) {
    score += 3;
    signals.push("recaptcha_widget_container");
  }
  if (HCAPTCHA_WIDGET.test(html)) {
    score += 3;
    signals.push("hcaptcha_widget_container");
  }
  if (TURNSTILE_WIDGET.test(html)) {
    score += 3;
    signals.push("turnstile_widget_container");
  }

  // A readable application form is strong evidence nothing is blocking us.
  const formUsable = Boolean(input.formDetected) && (input.fieldCount ?? 0) > 0;
  if (formUsable && score > 0) {
    score -= 2;
    signals.push("readable_application_form_present");
  }
  // Conversely, a challenge with no usable form behind it is the blocking case.
  if (!formUsable && score > 0) {
    score += 2;
    signals.push("no_readable_form_behind_challenge");
  }

  if (RECAPTCHA_API_SCRIPT.test(html)) {
    dormantMarkers.push("recaptcha_api_script_loaded");
  }
  if (RECAPTCHA_V3_BADGE.test(html)) {
    dormantMarkers.push("recaptcha_v3_badge");
  }
  if (GRECAPTCHA_GLOBAL.test(html)) {
    dormantMarkers.push("grecaptcha_reference");
  }
  if (SITEKEY_ATTR.test(html)) {
    dormantMarkers.push("data_sitekey_attribute");
  }
  if (GENERIC_CAPTCHA_WORD.test(html) && signals.length === 0) {
    dormantMarkers.push("generic_captcha_word_only");
  }

  if (score >= HIGH_THRESHOLD) {
    return { detected: true, confidence: "HIGH", signals, dormantMarkers };
  }
  if (score >= MEDIUM_THRESHOLD) {
    return { detected: false, confidence: "MEDIUM", signals, dormantMarkers };
  }
  return { detected: false, confidence: "LOW", signals, dormantMarkers };
}
