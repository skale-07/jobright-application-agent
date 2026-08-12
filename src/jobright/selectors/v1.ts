/**
 * JobRight selector registry v1 — derived from live captures under
 * fixtures/live-captures/{job-feed,apply-autofill,resume-generator,cover-letter}.
 *
 * Prefer role/text and stable URL/class *prefixes* over hashed CSS module suffixes.
 * Contacts workflows are intentionally incomplete in v1 (weak captures).
 */

export const JOBRIGHT_SELECTOR_REGISTRY_VERSION = 2;

export const jobrightSelectorsV1 = {
  urls: {
    recommendFeed: "https://jobright.ai/jobs/recommend",
    jobInfoPathPrefix: "/jobs/info/",
    jobInfoUrlPattern: /\/jobs\/info\/([a-f0-9]+)/i,
  },

  /**
   * Feed / navigation. Prefix matching, not exact: these are used as
   * logged-in evidence, and the live app appends query params to nav hrefs.
   */
  nav: {
    jobsRecommend: 'a[href^="/jobs/recommend"]',
    applied: 'a[href^="/jobs/applied"]',
    liked: 'a[href^="/jobs/liked"]',
  },

  feed: {
    /** Job detail links in the recommend feed */
    jobInfoLinks: 'a[href*="/jobs/info/"]',
    jobTitle: '[class*="job-title"]',
    companyName: '[class*="company-name"]',
    primaryLocation: '[class*="primary-location"]',
    jobMetadataItem: '[class*="job-metadata-item"]',
    /** Card-level apply CTA visible on feed cards */
    applyWithAutofillRole: /apply with autofill/i,
    askOrionRole: /ask orion/i,
  },

  jobDetail: {
    applyWithAutofill: {
      role: "button" as const,
      name: /apply with autofill/i,
    },
    improveResume: {
      role: "button" as const,
      name: /improve my resume for this job/i,
    },
    copyCoverLetter: {
      role: "button" as const,
      name: /copy cover letter/i,
    },
    coverLetterEditor: '[class*="cover-letter-editor"]',
    coverLetterText: '[class*="cover-letter-editor"] .ProseMirror',
    resumeAlignSubmit: '[class*="resume-align-submit-button"]',
    skillTag: '[class*="skill-tag"]',
  },

  /**
   * Navigation layer (N-series). UNVERIFIED_SELECTOR status: authored from
   * captures, not yet promoted by a live nav run.
   */
  navigation: {
    /** Anchors pointing at known ATS hosts — read hrefs, don't just count. */
    externalAtsAnchors:
      'a[href*="greenhouse.io"], a[href*="lever.co"], a[href*="myworkdayjobs"], a[href*="ashbyhq.com"], a[href*="workable.com"]',
    /** Fallback: any external https anchor opening a new tab. */
    externalAnyAnchor: 'a[target="_blank"][href^="https://"]',
    /**
     * Standard Apply (NOT "Apply with Autofill" — that is JobRight's own
     * flow). Tiered matching: live runs showed the exact-name tier missing
     * real controls named "Apply now" / "Apply on company site", which sent
     * every such job to the agent phase. Tier 1 is exact-ish; tier 2 is any
     * name containing "apply", filtered by the exclusion regex (JobRight's
     * own autofill CTA, past-tense "Applied", LinkedIn-style "Easy Apply").
     */
    standardApplyRole: /^apply(?:\s+(?:now|today|here))?$/i,
    broadApplyRole: /apply/i,
    applyNameExclusions: /autofill|applied|easy\s*apply|ask\s*orion/i,
    /**
     * Operator finding (2026-08-11 screenshot): the primary "APPLY WITH
     * AUTOFILL ↗" CTA on the job page carries the EXTERNAL application
     * link — it was sitting inside the exclusion list while phases A/B
     * hunted everywhere else. Tier 0 reads its href zero-mutation first,
     * then click-captures it before the standard tiers.
     */
    autofillApplyCta: /apply\s+with\s+autofill/i,
    /**
     * JobRight banners that mean the posting is DEAD. Operator finding
     * (2026-08-12): "This job has closed." sits in the header while the
     * nav phases spend minutes hunting an Apply control that will never
     * work. Seeing this ends the run immediately.
     */
    closedJobMarkers:
      /this job (?:has|is) closed|no longer accepting applications|position (?:has been|is) (?:closed|filled)|posting (?:has )?closed/i,
    /**
     * JobRight's own modals (e.g. "Did you apply?") interrupt navigation.
     * Their buttons are answers, not dismissals — the CLOSE control is the
     * only safe click, so it gets its own selector rather than relying on
     * the generic dismissive-name whitelist.
     */
    /**
     * JobRight interstitials that stand between the operator and the
     * employer form and offer a PROCEED action (operator finding
     * 2026-08-12: "Customize Your Resume in 10 seconds" → "Apply Without
     * Customizing"). These are the only "apply"-named controls this system
     * clicks inside a modal, matched exactly — they continue the flow the
     * operator already chose rather than starting a new one.
     */
    interstitialProceedNames: [
      /^apply without customizing$/i,
      /^continue without customizing$/i,
      /^skip( and)? (apply|continue)$/i,
      /^apply anyway$/i,
    ] as RegExp[],
    modalCloseControl:
      '[role="dialog"] [aria-label="Close" i], [role="dialog"] button.ant-modal-close, .ant-modal-close, [class*="modal"] [aria-label="close" i]',
    status: "UNVERIFIED_SELECTOR" as const,
  },

  /** Partial — do not treat as production-complete */
  contacts: {
    findMoreConnections: /find more connections/i,
    beyondYourNetwork: /beyond your network/i,
    connectViaEmail: /connect via email/i,
    connectNow: /connect now/i,
    findFromYourSchool: /find from your school/i,
    supportedInV1: false,
    note: "School/beyond/email contact selectors deferred until stronger live captures.",
  },
} as const;

export type JobrightSelectorsV1 = typeof jobrightSelectorsV1;
