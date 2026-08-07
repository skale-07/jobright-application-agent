/**
 * Ashby application forms (jobs.ashbyhq.com/<org>/<job-uuid>/application) —
 * React SPA: fetched HTML is an unrendered shell; all field selectors below
 * assume a rendered DOM (live page or rendered-DOM snapshot fixture).
 * Authored from Ashby's public form conventions; not yet confirmed against
 * captured live DOM (see tests/fixtures/ats/ashby/SYNTHETIC_FIXTURE.json).
 */
export const ashbySelectorsV1 = {
  form: "form",
  submit: "button[type='submit']",
  resume:
    "input[type='file'][name='_systemfield_resume'], input[type='file'][id*='_systemfield_resume']",
  /** Stable name-attribute prefix on Ashby's built-in fields. */
  systemFieldPrefix: "_systemfield_",
  buttonGroup: {
    container: "[role='radiogroup']",
    pressed:
      "[aria-pressed='true'], [aria-checked='true'], [data-selected='true']",
  },
  combobox: {
    /** Portal-rendered — search page-wide and filter to visible. */
    listbox: "[role='listbox']",
    option: "[role='option']",
    /** Committed display node next to the combobox input. */
    selectedValue: "[class*='__selected'], [data-selected-label]",
    placeholder: /^(select|select an option|start typing|search)(\.{3}|…)?$/i,
  },
  /** Rendered-DOM form presence (matches nothing on the unrendered shell). */
  formMarkers: /_systemfield_|ashby-application-form|role=["']radiogroup["']/i,
  loginMarkers: /sign in to apply|log in to apply/i,
  /** In-page success panel — Ashby does not navigate on submit. */
  confirmationMarkers:
    /application (?:has been )?submitted|thank you for applying|we(?:'|’)ve received your application/i,
  /** Unrendered SPA shell heuristics. */
  shellMarkers: /window\.__appData|__NEXT_DATA__|id=["']root["']/i,
} as const;
