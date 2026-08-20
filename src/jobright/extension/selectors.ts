/**
 * JobRight browser-extension UI selectors — versioned registry (house
 * rule: selectors never live inline in flow code).
 *
 * EVERYTHING here is UNVERIFIED until promoted from a real
 * `jobright:ext-capture` run: the extension's injected UI has never been
 * observed by this codebase (no capture artifact exists yet). The
 * candidates below are conservative guesses used only by the read-only
 * DOM presence probe — the autofill TRIGGER list ships empty on purpose,
 * so activation fails closed (falls back to native fill) until the
 * operator captures the real panel once.
 */
export const EXT_SELECTOR_REGISTRY_VERSION = "jobrightExtensionSelectorsV1";

export const jobrightExtensionSelectorsV1 = {
  /**
   * Read-only presence markers checked on an ATS page. Playwright
   * locators pierce open shadow roots, so a shadow-DOM panel with a
   * jobright-ish id/class is still found; a closed root or extension
   * iframe is not — which is why absence of these markers NEVER proves
   * the extension is absent (verdict stays "unknown").
   */
  domMarkers: [
    '[id*="jobright" i]',
    '[class*="jobright" i]',
    '[data-jobright]',
  ] as string[],
  /**
   * Controls that ACTIVATE the extension's autofill on an ATS page.
   * Empty until an ext-capture run observes the real panel — an empty
   * list makes attemptJobRightAutofill report "trigger not found" and
   * the pipeline fall back to native fill (fail closed, no blind
   * clicking).
   */
  autofillTrigger: [] as string[],
  /**
   * Text the extension's UI shows while its fill is in progress /
   * finished — used (once captured) to bound the settle wait instead of
   * a blind timeout. Empty ⇒ settle is time-bounded polling only.
   */
  progressMarkers: [] as string[],
};
