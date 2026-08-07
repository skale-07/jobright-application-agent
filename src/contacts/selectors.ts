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
