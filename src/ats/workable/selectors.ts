/**
 * Workable hosted application forms
 * (apply.workable.com/<company>/j/<SHORTCODE>/apply/) — the Tier-1
 * exemplar adapter: single-page React form with stable `data-ui` hooks and
 * SEPARATE first/last name fields (no full-name composition needed).
 *
 * UNVERIFIED_SELECTOR: authored from Workable's public form conventions,
 * not yet confirmed against a captured live DOM (see
 * tests/fixtures/ats/workable/SYNTHETIC_FIXTURE.json). The live-fill
 * form-snapshot instrumentation captures the real DOM on first encounter;
 * the /improve loop heals from there.
 */
export const workableSelectorsV1 = {
  form: "form[data-ui='application-form'], form#application-form, form[action*='/apply']",
  fieldContainer: "[data-ui='application-question'], .form-field",
  submit:
    "button[data-ui='submit-application'], button[data-ui='apply-button'], button[type='submit']",
  /** Ranked submit resolution (see shared/submitControl.ts). */
  submitCascade: {
    form: "form[data-ui='application-form'], form#application-form, form[action*='/apply']",
    css: "button[data-ui='submit-application'], button[data-ui='apply-button'], button[type='submit'], input[type='submit']",
    namePattern: /submit\s+application|^submit$|^apply(\s+now)?$/i,
    excludePattern:
      /^(next|continue|back|previous|cancel|close|save|yes|no|sign in|log in|upload|attach|autofill)\b/i,
  },
  resume:
    "input[type='file'][data-ui='resume'], input[type='file'][name='resume'], input[type='file'][id*='resume' i]",
  loginMarkers: /sign in to apply|log in to apply|create an account to apply/i,
  /** HTML-side form presence (no browser). */
  formMarkers:
    /data-ui=["']application-form["']|data-ui=["']submit-application["']|whr-form|id=["']application-form["']/i,
  /**
   * Post-submit confirmation. Workable shows an in-page/redirected
   * thank-you; deliberately narrow — generic "thank you for your interest"
   * posting copy is NOT a confirmation signal.
   */
  confirmationMarkers:
    /application (?:submitted|received)|thank you for (?:applying|your application)|your application has been (?:submitted|received)|successfully applied/i,
  status: "UNVERIFIED_SELECTOR" as const,
} as const;
