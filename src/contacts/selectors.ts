/**
 * JobRight contacts selector registry v1.
 *
 * Derived from a SYNTHETIC fixture, not live captures — the recorder's
 * school-contacts / beyond-network workflows never produced strong captures
 * (see src/jobright/selectors/v1.ts contacts.supportedInV1 = false).
 * Every selector here is live-UNVERIFIED until an operator promotes a real
 * sanitized capture via the recorder and re-tests.
 */
export const CONTACTS_SELECTOR_REGISTRY_VERSION = "contacts-v1";

export const contactsSelectorsV1 = {
  validation: "UNVERIFIED" as const,
  /** Container of one recommended contact. */
  card: '[class*="contact-card"]',
  name: '[class*="contact-name"]',
  title: '[class*="contact-title"]',
  company: '[class*="contact-company"]',
  /** Section headings that classify the source of the contacts below them. */
  sections: {
    school: /find (?:more connections )?from your school/i,
    beyond: /beyond your network/i,
    email: /connect via email/i,
  },
  /** data attribute JobRight uses for the contact id (synthetic guess). */
  contactIdAttr: "data-contact-id",
} as const;

export type ContactSourceCategory = "school" | "beyond" | "email" | "unknown";

/**
 * Insider Connection email-triage registry (operator directive 2026-08-18,
 * grounded in their annotated screenshots of jobright.ai/jobs/info/*).
 *
 * The triage walks ONLY the "From Your School" and "Beyond Your Network"
 * panels — "From Your Previous Company" is deliberately excluded. All
 * copy anchors match the screenshots verbatim; DOM-shape guesses are
 * synthetic and live-UNVERIFIED until the operator promotes a run.
 */
export const INSIDER_SELECTOR_REGISTRY_VERSION = "insider-v1";

export const insiderSelectorsV1 = {
  validation: "UNVERIFIED" as const,
  /** Panels the triage may open. Previous-company is NOT listed. */
  panels: [
    { category: "school" as ContactSourceCategory, heading: /from your school/i },
    { category: "beyond" as ContactSourceCategory, heading: /beyond your network/i },
  ],
  /** The collapsed panel's expander. Both spellings appear in screenshots. */
  expandButton: /^(view|find more connections)$/i,
  /** Lookup outcome popups. */
  foundPopup: /contact info found/i,
  notFoundPopup: /contact info not found/i,
  connectNow: /^connect now$/i,
  /** Present only on the not-found popup — never clicked, used to classify. */
  connectOnLinkedin: /connect on linkedin/i,
  /** The email modal. */
  emailModal: /connect via email/i,
  cancelButton: /^cancel$/i,
  /**
   * FORBIDDEN control: the triage must never send. Kept in the registry so
   * the guard is data, not prose — the engine asserts it never matches a
   * click target.
   */
  startEmailButton: /^start email$/i,
  /** Something that looks like a mailbox, nothing else scraped. */
  emailPattern: /[a-z0-9][a-z0-9._%+-]*@[a-z0-9.-]+\.[a-z]{2,}/gi,
} as const;
