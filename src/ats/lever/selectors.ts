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
  resume: "input[type='file'][name='resume'], #resume-upload-input",
  loginMarkers: /sign in to apply|log in to apply|create an account to apply/i,
  /** HTML-side form presence (no browser). */
  formMarkers:
    /data-qa=["']btn-submit["']|name=["']cards\[|class=["'][^"']*application-form/i,
  /** Dormant vs blocking is decided by detectBlockingCaptcha, not this. */
  hcaptchaMarkers: /h-captcha|hcaptcha\.com/i,
  /** Post-submit confirmation (/thanks page or in-page banner). */
  confirmationMarkers:
    /application submitted|thank you for (?:applying|your (?:application|interest))|your application has been received/i,
} as const;
