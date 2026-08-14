import { detectLoginWall } from "../greenhouse/loginWallDetection.js";
import { detectBlockingCaptcha } from "../greenhouse/captchaDetection.js";
import { discoverFieldsFromHtml } from "../../applications/fieldDiscovery.js";

/**
 * Vendor-blind page classification — the answer to "where did that click
 * actually land?". The building blocks (login-wall detection, CAPTCHA
 * detection, field counting, confirmation markers) all existed separately;
 * every transition used to discover a wrong landing indirectly, far from
 * the click that caused it (gate refusal, empty plan, verify miss). One
 * classifier, asserted right at the transition, names the landing
 * immediately.
 *
 * Order matters: captcha and auth walls dominate (a login page can carry
 * stray inputs), confirmation beats form (thank-you pages keep search
 * boxes), and a field-less page with an Apply-ish CTA is a posting.
 */
export type PageClass =
  | "captcha"
  | "auth"
  | "confirmation"
  | "form"
  | "posting"
  | "unknown";

export type PageClassification = {
  page_class: PageClass;
  field_count: number;
  evidence: string;
};

const GENERIC_CONFIRMATION_RE =
  /thank you for (applying|your application)|application (submitted|received|complete)|you(?:'ve| have) successfully (applied|submitted)/i;

const APPLY_CTA_RE =
  /\bapply(?:\s+now)?\b[^<]{0,40}<|data-automation-id=["']adventureButton["']|>\s*apply\s*</i;

export function classifyPage(input: {
  html: string;
  url: string;
  title?: string;
  /** Per-ATS confirmation markers (selector registries) widen the generic set. */
  confirmationMarkers?: RegExp;
}): PageClassification {
  const { html, url } = input;
  const title = input.title ?? "";
  const fields = discoverFieldsFromHtml(html);
  const fieldCount = fields.length;

  const captcha = detectBlockingCaptcha({
    finalUrl: url,
    html,
    title,
    formDetected: fieldCount > 0,
    fieldCount,
  });
  if (captcha.detected) {
    return {
      page_class: "captcha",
      field_count: fieldCount,
      evidence: `captcha: ${captcha.signals.join(",")}`,
    };
  }

  const wall = detectLoginWall({ finalUrl: url, html, title });
  if (wall.detected) {
    return {
      page_class: "auth",
      field_count: fieldCount,
      evidence: `login wall: ${wall.signals.join(",")}`,
    };
  }

  const confirmed =
    (input.confirmationMarkers?.test(html) ?? false) ||
    GENERIC_CONFIRMATION_RE.test(html);
  if (confirmed) {
    return {
      page_class: "confirmation",
      field_count: fieldCount,
      evidence: "confirmation markers matched",
    };
  }

  if (fieldCount > 0) {
    return {
      page_class: "form",
      field_count: fieldCount,
      evidence: `${fieldCount} fillable field(s)`,
    };
  }

  if (APPLY_CTA_RE.test(html)) {
    return {
      page_class: "posting",
      field_count: 0,
      evidence: "no fields, Apply CTA present",
    };
  }

  return { page_class: "unknown", field_count: 0, evidence: "no signals matched" };
}
