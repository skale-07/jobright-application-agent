/**
 * High-confidence login-wall detection for Greenhouse inspection.
 * A generic nav "Login" link alone must never stop inspection.
 */

export type LoginWallDetection = {
  detected: boolean;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  signals: string[];
};

const AUTH_URL =
  /\/(login|signin|sign-in|auth|oauth|sso|session)(\/|$|\?)/i;

const AUTH_HEADING =
  /<(h1|h2)[^>]{0,80}>\s*(sign[\s-]?in|log[\s-]?in)\s*</i;

const PASSWORD_INPUT =
  /<input[^>]+type=["']password["'][^>]*>/i;

const EMAIL_OR_USER_INPUT =
  /<input[^>]+(?:type=["']email["']|name=["'][^"']*(?:email|username|user)[^"']*["']|id=["'][^"']*(?:email|username|user)[^"']*["'])[^>]*>/i;

const AUTH_FORM_ACTION =
  /<form[^>]+action=["'][^"']*(login|signin|sign-in|auth|oauth|session)[^"']*["'][^>]*>/i;

const AUTH_PROVIDER =
  /accounts\.google\.com|login\.microsoftonline\.com|okta\.com\/login|auth0\.com|cognito/i;

/**
 * Detect a real authentication wall. Requires strong contextual evidence.
 * Returns detected:true only for HIGH confidence.
 */
export function detectLoginWall(input: {
  finalUrl: string;
  html: string;
  title?: string;
}): LoginWallDetection {
  const signals: string[] = [];
  const html = input.html.slice(0, 80_000);
  const title = (input.title ?? "").toLowerCase();

  let score = 0;

  if (AUTH_URL.test(input.finalUrl)) {
    score += 3;
    signals.push("final_url_auth_path");
  }
  if (AUTH_PROVIDER.test(input.finalUrl) || AUTH_PROVIDER.test(html)) {
    score += 2;
    signals.push("auth_provider_marker");
  }
  if (PASSWORD_INPUT.test(html)) {
    signals.push("password_input_visible_in_dom");
    if (EMAIL_OR_USER_INPUT.test(html)) {
      signals.push("email_and_password_inputs");
    }
    // A password field is the wall. The old score>=5 threshold left
    // password-only SPA pages as MEDIUM, so the mutation gate collapsed
    // them to NO_APPLICATION_FORM and fill never attempted sign-in.
    // Header "Log in" links still do not count — they add no password input.
    return { detected: true, confidence: "HIGH", signals };
  }
  if (AUTH_HEADING.test(html) || /\b(sign in|log in)\b/i.test(title)) {
    score += 2;
    signals.push("sign_in_heading_or_title");
  }
  if (AUTH_FORM_ACTION.test(html)) {
    score += 2;
    signals.push("auth_form_action");
  }

  // Weak / insufficient alone — record for diagnostics only
  const weakNavOnly =
    /<(a|button)[^>]*>\s*login\s*<\/(a|button)>/i.test(html) ||
    /\bhref=["'][^"']*login[^"']*["']/i.test(html);
  if (weakNavOnly && score < 5) {
    signals.push("generic_login_nav_ignored");
  }

  if (score >= 5) {
    return { detected: true, confidence: "HIGH", signals };
  }
  if (score >= 3) {
    return { detected: false, confidence: "MEDIUM", signals };
  }
  if (signals.length > 0) {
    return { detected: false, confidence: "LOW", signals };
  }
  return { detected: false, confidence: "LOW", signals: [] };
}
