/**
 * JobRight selector registry v1 — derived from live captures under
 * fixtures/live-captures/{job-feed,apply-autofill,resume-generator,cover-letter}.
 *
 * Prefer role/text and stable URL/class *prefixes* over hashed CSS module suffixes.
 * Contacts workflows are intentionally incomplete in v1 (weak captures).
 */

export const JOBRIGHT_SELECTOR_REGISTRY_VERSION = 1;

export const jobrightSelectorsV1 = {
  urls: {
    recommendFeed: "https://jobright.ai/jobs/recommend",
    jobInfoPathPrefix: "/jobs/info/",
    jobInfoUrlPattern: /\/jobs\/info\/([a-f0-9]+)/i,
  },

  /** Feed / navigation */
  nav: {
    jobsRecommend: 'a[href="/jobs/recommend"]',
    applied: 'a[href="/jobs/applied"]',
    liked: 'a[href="/jobs/liked"]',
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
