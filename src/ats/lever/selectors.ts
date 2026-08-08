/**
 * Lever postings forms (jobs.lever.co/<company>/<posting-uuid>/apply) —
 * server-rendered classic HTML, stable name attributes, data-qa hooks.
 * Authored from Lever's public form conventions; not yet confirmed against
 * captured live DOM (see tests/fixtures/ats/lever/SYNTHETIC_FIXTURE.json).
 */
export const leverSelectorsV1 = {
  form: "form#application-form, form[action*='/apply'], form.application-form",
  fieldContainer: ".application-field, .application-question",
  submit:
    "button[data-qa='btn-submit'], .template-btn-submit, button[type='submit']",
  /** Ranked submit resolution (see shared/submitControl.ts). */
  submitCascade: {
    form: "form#application-form, form[action*='/apply'], form.application-form",
    css: "button[data-qa='btn-submit'], .template-btn-submit, button[type='submit'], input[type='submit']",
    namePattern: /submit\s+application|^submit$|^apply(\s+now)?$/i,
    excludePattern:
      /^(next|continue|back|previous|cancel|close|save|yes|no|sign in|log in|upload|attach)\b/i,
  },
  resume: "input[type='file'][name='resume'], #resume-upload-input",
  loginMarkers: /sign in to apply|log in to apply|create an account to apply/i,
  /** HTML-side form presence (no browser). */
  formMarkers:
    /data-qa=["']btn-submit["']|name=["']cards\[|class=["'][^"']*application-form/i,
  /**
   * Post-submit confirmation (/thanks page or in-page banner). Deliberately
   * narrow: "thank you for your interest" is common posting/footer copy on
   * pages that were never submitted, so it is NOT a confirmation signal.
   */
  confirmationMarkers:
    /application submitted|thank you for (?:applying|your application)|your application has been received/i,
} as const;
