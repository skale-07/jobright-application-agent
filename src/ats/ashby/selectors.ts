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
  /**
   * Ranked submit resolution (see shared/submitControl.ts). Live Ashby
   * renders a custom React footer whose CTA is frequently type="button"
   * with the text "Submit application" — the accessible-name tier is the
   * one that survives that; the CSS tier keeps the fixture/classic path.
   * Wizard/nav controls are excluded by name: clicking "Next" and calling
   * it a submit is the failure mode this exists to prevent.
   */
  submitCascade: {
    form: "form",
    css: "button[type='submit'], input[type='submit']",
    namePattern: /submit\s+application|^submit$|^apply(\s+now)?$/i,
    excludePattern:
      /^(next|continue|back|previous|cancel|close|save|yes|no|sign in|log in|upload|attach)\b/i,
  },
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
  /** Broad detection markers — may also hit script/JSON blobs. */
  formMarkers: /_systemfield_|ashby-application-form|role=["']radiogroup["']/i,
  /**
   * Rendered form controls ONLY (attribute syntax inside a tag — embedded
   * JSON like {"name":"_systemfield_name"} does not match). Used where a
   * script blob must not count as "the form is still here": the
   * post-submit classifier and the live form-present gate.
   */
  renderedFormMarkers:
    /<(input|textarea|select)[^>]*_systemfield_|<div[^>]*role=["']radiogroup["']|<form[^>]*>[\s\S]*?<input/i,
  loginMarkers: /sign in to apply|log in to apply/i,
  /** In-page success panel — Ashby does not navigate on submit. */
  confirmationMarkers:
    /application (?:has been )?submitted|thank you for applying|we(?:'|’)ve received your application/i,
  /** Unrendered SPA shell heuristics. */
  shellMarkers: /window\.__appData|__NEXT_DATA__|id=["']root["']/i,
} as const;
