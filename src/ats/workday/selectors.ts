/**
 * Workday hosted career sites (<tenant>.wdN.myworkdayjobs.com) — Tier-2:
 * a multi-page wizard behind a per-tenant account. Workday ships stable
 * `data-automation-id` hooks across tenants; these selectors are authored
 * from those public conventions.
 *
 * UNVERIFIED_SELECTOR: not yet confirmed against a captured live DOM. The
 * live-fill form-snapshot instrumentation captures the real DOM on first
 * encounter; the /improve loop heals from there.
 */
export const workdaySelectorsV1 = {
  /** Posting page: the Apply button that opens the auth/apply flow. */
  applyButton:
    "a[data-automation-id='adventureButton'], button[data-automation-id='adventureButton'], a[role='button'][data-uxi-element-id*='Apply' i]",
  /** Apply-method chooser after Apply. */
  applyMethods: {
    autofillWithResume: "a[data-automation-id='autofillWithResume'], button[data-automation-id='autofillWithResume']",
    applyManually: "a[data-automation-id='applyManually'], button[data-automation-id='applyManually']",
  },
  auth: {
    /** Sign-in / create-account page detection. */
    emailInput:
      "input[data-automation-id='email'], input[type='email'][data-automation-id], input[data-automation-id='userName']",
    passwordInput: "input[data-automation-id='password']",
    verifyPasswordInput: "input[data-automation-id='verifyPassword']",
    createAccountCheckbox: "input[data-automation-id='createAccountCheckbox']",
    signInSubmit:
      "button[data-automation-id='signInSubmitButton'], button[data-automation-id='click_filter']",
    createAccountSubmit:
      "button[data-automation-id='createAccountSubmitButton'], button[data-automation-id='click_filter']",
    /** Link/button that flips between the two auth forms. */
    createAccountLink:
      "button[data-automation-id='createAccountLink'], a[data-automation-id='createAccountLink']",
    signInLink:
      "button[data-automation-id='signInLink'], a[data-automation-id='signInLink']",
    /** Email-verification code entry (tenants that require it). */
    verificationCodeInput:
      "input[data-automation-id='verificationCode'], input[autocomplete='one-time-code']",
    verificationSubmit:
      "button[data-automation-id='verifyButton'], button[data-automation-id='click_filter']",
    /** Page-text markers. */
    signInMarkers: /sign in|log in/i,
    createAccountMarkers: /create account|create an account|sign up/i,
    badCredentialsMarkers:
      /incorrect|invalid|doesn'?t match|does not match|no account|can'?t find|verify your email/i,
  },
  wizard: {
    /** Wizard page container + progress bar. */
    pageMarkers:
      /data-automation-id=["']progressBar|data-automation-id=["']myInformationPage|My Information|Application Questions|Voluntary Disclosures|Self Identify|Review/i,
    nextButton:
      "button[data-automation-id='bottom-navigation-next-button'], button[data-automation-id='pageFooterNextButton']",
    /** FINAL submit — never clicked outside the gated submit path. */
    submitButton: "button[data-automation-id='bottom-navigation-submit-button'], button[data-automation-id='pageFooterSubmitButton']",
    resumeUpload:
      "input[data-automation-id='file-upload-input-ref'], input[type='file']",
    /** My Information page fields. */
    fields: {
      firstName: "input[data-automation-id='legalNameSection_firstName']",
      lastName: "input[data-automation-id='legalNameSection_lastName']",
      email: "input[data-automation-id='email']",
      phone: "input[data-automation-id='phone-number']",
      addressLine1: "input[data-automation-id='addressSection_addressLine1']",
      city: "input[data-automation-id='addressSection_city']",
      postalCode: "input[data-automation-id='addressSection_postalCode']",
      /** Dropdown buttons (Workday custom selects). */
      state: "button[data-automation-id='addressSection_countryRegion']",
      country: "button[data-automation-id='addressSection_country']",
      phoneType: "button[data-automation-id='phone-device-type']",
      source: "button[data-automation-id='sourceSection_source']",
      previousWorker: "input[data-automation-id='previousWorker']",
    },
  },
  /** Post-submit confirmation — deliberately narrow. */
  confirmationMarkers:
    /application (?:submitted|received|complete)|thank you for applying|you(?:'ve| have) successfully (?:applied|submitted)/i,
  formMarkers: /data-automation-id=/i,
  status: "UNVERIFIED_SELECTOR" as const,
} as const;
