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
      'a[href*="greenhouse.io"], a[href*="lever.co"], a[href*="myworkdayjobs"], a[href*="ashbyhq.com"]',
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
