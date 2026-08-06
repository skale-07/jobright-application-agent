/**
 * Greenhouse board forms — prefer #application_form and data attributes
 * over brittle class chains.
 */
export const greenhouseSelectorsV1 = {
  form: "#application_form, form#new_job_application, form[action*='greenhouse']",
  fieldContainer: ".field, .application--field, .field--text, .field--textarea",
  requiredMarker: ".required, [aria-required='true'], .asterisk",
  resume: "input[type='file'][name*='resume' i], #resume",
  coverLetter: "input[type='file'][name*='cover' i], #cover_letter",
  submit: "input[type='submit'], button[type='submit']",
  loginMarkers: /sign in|log in|create an account|create account/i,
  /** HTML-side form presence (no browser). Mirrors the `form` CSS selector. */
  formMarkers: /id=["']application_form["']|new_job_application/i,
} as const;
