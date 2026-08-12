/**
 * Outlook web (outlook.office.com / live.com) selector registry v1.
 *
 * SYNTHETIC basis: aria-label patterns typical of Outlook web, never
 * confirmed against the live mailbox. Every selector is live-UNVERIFIED
 * until the operator runs draft:create --headed and the registry is
 * corrected from what the real DOM shows. Outlook's DOM churns often —
 * verifyOutlookDraft (subject/recipient/body-hash re-check) is the
 * acceptance test that matters, not selector optimism.
 */
export const OUTLOOK_SELECTOR_REGISTRY_VERSION = "outlook-web-v1";

export const outlookSelectorsV1 = {
  validation: "UNVERIFIED" as const,
  compose: {
    newMailButton:
      'button[aria-label*="New mail" i], [aria-label*="New message" i]',
    toField:
      '[aria-label*="To" i][role="textbox"], input[aria-label*="To" i]',
    subjectField:
      'input[aria-label*="Add a subject" i], input[aria-label*="Subject" i]',
    bodyField:
      '[aria-label*="Message body" i][role="textbox"], [contenteditable="true"][aria-label*="body" i]',
    /** Closing the compose surface lets Outlook autosave into Drafts. */
    closeButton:
      'button[aria-label*="Close" i], button[aria-label*="Discard" i]:not([aria-label*="Discard draft" i])',
  },
  drafts: {
    folderLink: '[title="Drafts"], a[aria-label*="Drafts" i]',
    listItem: '[role="option"], [role="listitem"]',
  },
  /** Read-only mailbox scan for verification codes (submit recovery). */
  mail: {
    inboxListItem: '[role="option"], [role="listitem"]',
    readingPaneBody:
      '[aria-label*="Message body" i], [role="document"], .allowTextSelection',
  },
} as const;
