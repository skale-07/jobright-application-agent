import { normalizeFieldLabel } from "./fieldNormalization.js";

function decodeBasicHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Application-process consent: terms / privacy / "I certify this is true".
 * Checking these is inherent in submitting. Marketing opt-ins, EEO, and
 * unlabeled Lever card checkboxes are not this.
 *
 * Live evidence (Lever 1786324702240): `consent[marketing]` must stay
 * skipped; unlabeled `cards[uuid][fieldN]` has no terms text to match.
 */
export const APPLICATION_CONSENT_PREFIX = "application_consent";

const MARKETING_RE =
  /market(ing)?|newsletter|job alerts?|sms|text message|promotional|future opportunit/;

const CONSENT_RE =
  /privacy( policy)?|terms\s*((of\s+(service|use|condition))|(&|and)?\s*conditions)|i agree|i acknowledge|i certify|i confirm|acknowledge|notice at collection|personal data|true and complete|information (is|provided) (true|accurate)|data processing|gdpr/;

export function isApplicationConsentField(field: {
  type: string;
  label: string;
  name?: string | null;
  inputId?: string | null;
}): boolean {
  if (field.type !== "checkbox") return false;
  const n = normalizeFieldLabel(
    decodeBasicHtmlEntities(
      `${field.label} ${field.name ?? ""} ${field.inputId ?? ""}`,
    ),
  );
  if (n.length < 8) return false;
  if (MARKETING_RE.test(n)) return false;
  return CONSENT_RE.test(n);
}

export function consentCanonicalFor(fieldId: string): string {
  return `${APPLICATION_CONSENT_PREFIX}:${fieldId}`;
}

export function isConsentCanonical(
  canonical: string | null | undefined,
): boolean {
  if (!canonical) return false;
  return (
    canonical === APPLICATION_CONSENT_PREFIX ||
    canonical.startsWith(`${APPLICATION_CONSENT_PREFIX}:`)
  );
}
