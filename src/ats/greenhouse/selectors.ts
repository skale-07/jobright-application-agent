/**
 * Greenhouse board forms — prefer #application_form and data attributes
 * over brittle class chains.
 */
export const greenhouseSelectorsV1 = {
  form: "#application_form, form#new_job_application, form[action*='greenhouse']",
  fieldContainer: ".field, .application--field, .field--text, .field--textarea",
  requiredMarker: ".required, [aria-required='true'], .asterisk",
  /**
   * job-boards.greenhouse.io uses id-only file inputs (no name), class
   * visually-hidden. Prefer #id before name*= patterns.
   */
  resume:
    "input[type='file']#resume, #resume, input[type='file'][id*='resume' i], input[type='file'][name*='resume' i]",
  coverLetter:
    "input[type='file']#cover_letter, #cover_letter, input[type='file'][id*='cover' i], input[type='file'][name*='cover' i]",
  submit: "input[type='submit'], button[type='submit']",
  loginMarkers: /sign in|log in|create an account|create account/i,
  /** HTML-side form presence (no browser). Mirrors the `form` CSS selector. */
  formMarkers: /id=["']application_form["']|new_job_application/i,
  /** Post-submit confirmation page (Phase 7). */
  confirmation: "#application_confirmation, .application-confirmation",
  confirmationMarkers:
    /thank you for applying|application (?:has been|was) (?:submitted|received)|we have received your application/i,
} as const;
