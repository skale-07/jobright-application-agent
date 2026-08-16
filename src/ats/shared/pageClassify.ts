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
 * stray inputs — a password field is auth, even if an email box is also
 * present), confirmation beats form (thank-you pages keep search boxes),
 * and Apply without applicant identity is a posting.
 *
 * Form identity is disjunctive, not "first + last + resume". Wizard step 1
 * is often name+email with the resume on step 2; Lever uses one Full Name
 * field. Requiring the full contact block classifies real forms as unknown.
 * The listing-page discriminator is the one Eightfold taught: Apply CTA
 * plus none of the inputs asking who you are.
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

/**
 * Does this field set belong to something asking for an APPLICANT? Name,
 * email, phone or a resume upload — the questions every application form
 * asks and no listing page's search chrome ever does.
 *
 * Deliberately checks the label AND the machine name: a listing page's
 * "City, state, or country/region" search box maps to an address alias but
 * is not identity, so location is not on this list.
 */
export function hasApplicationIdentityFields(
  fields: Array<{ label: string; name?: string | undefined; type: string }>,
): boolean {
  return fields.some((f) => {
    const blob = `${f.label} ${f.name ?? ""}`.toLowerCase();
    if (/\b(search|keyword|job title, id)\b/.test(blob)) return false;
    return (
      /\be-?mail\b/.test(blob) ||
      /\bfirst[\s_-]*name\b|\blast[\s_-]*name\b|\bfull[\s_-]*name\b|\byour name\b/.test(
        blob,
      ) ||
      /\bphone\b|\bmobile number\b/.test(blob) ||
      (f.type === "file" && /resume|cv|cover[\s_-]*letter/.test(blob))
    );
  });
}

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

  // "Has inputs" is NOT "is an application form". Live 2026-08-14
  // (microsoft.eightfold.ai): the JOB LISTING page carried the site's own
  // search widgets — "Search by job title, ID, or keyword" and "City,
  // state, or country/region" — so fieldCount was 5, the page classified
  // as a form, and the run typed "United States" into a job-search box
  // while a plain "Apply now" button sat unclicked. A human saw it
  // instantly: wrong page, click Apply first.
  //
  // The discriminator is what the fields ARE. Every real application form
  // asks who you are; a listing page's search chrome never does. So an
  // Apply CTA plus no identity field means posting, however many inputs
  // the page's furniture contributes.
  const hasCta = APPLY_CTA_RE.test(html);
  if (fieldCount > 0) {
    if (hasCta && !hasApplicationIdentityFields(fields)) {
      return {
        page_class: "posting",
        field_count: fieldCount,
        evidence: `Apply CTA present and none of the ${fieldCount} field(s) ask who you are — page furniture, not an application`,
      };
    }
    return {
      page_class: "form",
      field_count: fieldCount,
      evidence: `${fieldCount} fillable field(s)`,
    };
  }

  if (hasCta) {
    return {
      page_class: "posting",
      field_count: 0,
      evidence: "no fields, Apply CTA present",
    };
  }

  return { page_class: "unknown", field_count: 0, evidence: "no signals matched" };
}
