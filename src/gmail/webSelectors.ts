/**
 * Gmail WEB mailbox selectors (mail.google.com) — the browser-based
 * verification path. The Gmail REST API is unavailable for this operator
 * (Google restricts the readonly scope to verified OAuth apps), so codes
 * are read from the rendered mailbox in the operator's Google-authenticated
 * browser session instead — read-only navigation + DOM reads, no compose
 * surface is ever touched.
 *
 * UNVERIFIED_SELECTOR: authored from Gmail's stable classic-DOM hooks
 * (tr.zA list rows, div.a3s message body) with role-based fallbacks; the
 * acceptance test is a code that actually unlocks a live flow.
 */
export const gmailWebSelectorsV1 = {
  mail: {
    /** Inbox list rows (classic DOM first, ARIA fallback). */
    inboxListItem: "tr.zA, [role='main'] table [role='row']",
    /** Opened-message body region. */
    readingPaneBody: "div.a3s, [role='main'] [data-message-id] [dir='ltr']",
    /** Row timestamp carrier — Gmail stamps a full datetime in span[title]. */
    rowTimestampAttr: "title",
  },
  status: "UNVERIFIED_SELECTOR" as const,
} as const;
