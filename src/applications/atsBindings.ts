import type { Page } from "playwright";
import type {
  SubmissionAttempt,
  SubmissionReceipt,
  SubmitClickOptions,
} from "../ats/adapter.js";
import { genericSelectorsV1 } from "../ats/generic/selectors.js";
import { isSameEmployerOrigin } from "../ats/generic/urlValidation.js";
import {
  genericSubmit,
  genericVerifySubmission,
} from "../ats/generic/submission.js";
import type { SupportedAtsId } from "../ats/shared/urlValidationDispatch.js";
import {
  greenhouseSubmit,
  greenhouseVerifySubmission,
} from "../ats/greenhouse/submission.js";
import { verifyPageBeforeMutation } from "../ats/greenhouse/liveFill.js";
import { leverSubmit, leverVerifySubmission } from "../ats/lever/submission.js";
import { ashbySubmit, ashbyVerifySubmission } from "../ats/ashby/submission.js";
import { isTrustedLeverHost } from "../ats/lever/urlValidation.js";
import { isTrustedAshbyHost } from "../ats/ashby/urlValidation.js";
import { isTrustedWorkableHost } from "../ats/workable/urlValidation.js";
import {
  workableSubmit,
  workableVerifySubmission,
} from "../ats/workable/submission.js";
import { workableSelectorsV1 } from "../ats/workable/selectors.js";
import { isTrustedWorkdayHost } from "../ats/workday/urlValidation.js";
import {
  workdaySubmit,
  workdayVerifySubmission,
} from "../ats/workday/submission.js";
import { workdaySelectorsV1 } from "../ats/workday/selectors.js";
import { greenhouseSelectorsV1 } from "../ats/greenhouse/selectors.js";
import { leverSelectorsV1 } from "../ats/lever/selectors.js";
import { ashbySelectorsV1 } from "../ats/ashby/selectors.js";
import { verifyPageBeforeMutationGeneric } from "../ats/shared/preMutationGate.js";

/**
 * Per-ATS capability table for the submit/live orchestrators. The
 * greenhouse binding is behavior-preserving (same gate/submit/verify calls
 * submitRun made directly before this table existed). Lever/Ashby bindings
 * use the weaker generic gate (no identity-verification equivalent exists —
 * see preMutationGate.ts) and call the module-level verify functions
 * directly so receipts land at the caller's screenshotPath (the adapters'
 * own verifySubmission methods write under artifacts/ats-submit/ instead,
 * which is not where per-application submission evidence belongs).
 */
export type AtsBindingGateResult = {
  ok: boolean;
  finalUrl: string;
  html: string;
  failureCode?: string | null;
  reason?: string | null;
};

export type AtsBinding = {
  id: SupportedAtsId;
  gate(
    page: Page,
    employerUrl: string,
    normalizedUrl?: string,
  ): Promise<AtsBindingGateResult>;
  submit(page: Page, opts?: SubmitClickOptions): Promise<SubmissionAttempt>;
  /** The submit control locator — used by disabled-submit diagnostics. */
  submitSelector: string;
  verifySubmission(
    page: Page,
    opts: { screenshotPath: string },
  ): Promise<SubmissionReceipt>;
  /** Human-essay fill path is wired for this ATS. */
  supportsEssayFill: boolean;
  /** Selector-heal pass is wired for this ATS. */
  supportsHealing: boolean;
};

export const ATS_BINDINGS: Record<SupportedAtsId, AtsBinding> = {
  /**
   * Company-hosted forms. Same gates as every vendor; two honest
   * differences: no essay fill (essay execution is Greenhouse-bound, so an
   * application carrying essay answers fails closed before submit), and
   * the page gate proves identity by same-employer-origin rather than by a
   * vendor host allowlist — the URL's trust already came from the JobRight
   * posting it was resolved from.
   */
  generic: {
    id: "generic",
    gate: (page, employerUrl, normalizedUrl) =>
      verifyPageBeforeMutationGeneric(page, {
        isTrustedHost: (url: string) =>
          isSameEmployerOrigin(normalizedUrl ?? employerUrl, url),
        formMarkers: genericSelectorsV1.formMarkers,
        ...(normalizedUrl ? { expectedUrl: normalizedUrl } : {}),
      }),
    submit: (page, opts) => genericSubmit(page, opts),
    submitSelector: genericSelectorsV1.submit,
    verifySubmission: (page, opts) => genericVerifySubmission(page, opts),
    supportsEssayFill: false,
    // The healer's locator is already vendor-free label similarity, and it
    // re-verifies deterministically — exactly what an unmodelled form needs.
    supportsHealing: true,
  },
  greenhouse: {
    id: "greenhouse",
    gate: (page, employerUrl, normalizedUrl) =>
      verifyPageBeforeMutation(page, employerUrl, normalizedUrl ?? null),
    submit: (page, opts) => greenhouseSubmit(page, opts),
    submitSelector: greenhouseSelectorsV1.submit,
    verifySubmission: (page, opts) => greenhouseVerifySubmission(page, opts),
    supportsEssayFill: true,
    supportsHealing: true,
  },
  lever: {
    id: "lever",
    gate: (page, _employerUrl, normalizedUrl) =>
      verifyPageBeforeMutationGeneric(page, {
        isTrustedHost: isTrustedLeverHost,
        formMarkers: leverSelectorsV1.formMarkers,
        ...(normalizedUrl ? { expectedUrl: normalizedUrl } : {}),
      }),
    submit: (page, opts) => leverSubmit(page, opts),
    submitSelector: leverSelectorsV1.submit,
    verifySubmission: (page, opts) => leverVerifySubmission(page, opts),
    supportsEssayFill: false,
    supportsHealing: false,
  },
  ashby: {
    id: "ashby",
    gate: (page, _employerUrl, normalizedUrl) =>
      verifyPageBeforeMutationGeneric(page, {
        isTrustedHost: isTrustedAshbyHost,
        // Rendered controls only — script blobs must not count as a form,
        // and the render wait needs a marker that appears only post-render.
        formMarkers: ashbySelectorsV1.renderedFormMarkers,
        ...(normalizedUrl ? { expectedUrl: normalizedUrl } : {}),
      }),
    submit: (page, opts) => ashbySubmit(page, opts),
    submitSelector: ashbySelectorsV1.submit,
    verifySubmission: (page, opts) => ashbyVerifySubmission(page, opts),
    supportsEssayFill: false,
    supportsHealing: false,
  },
  workable: {
    id: "workable",
    gate: (page, _employerUrl, normalizedUrl) =>
      verifyPageBeforeMutationGeneric(page, {
        isTrustedHost: isTrustedWorkableHost,
        formMarkers: workableSelectorsV1.formMarkers,
        ...(normalizedUrl ? { expectedUrl: normalizedUrl } : {}),
      }),
    submit: (page, opts) => workableSubmit(page, opts),
    submitSelector: workableSelectorsV1.submit,
    verifySubmission: (page, opts) => workableVerifySubmission(page, opts),
    supportsEssayFill: false,
    supportsHealing: false,
  },
  workday: {
    id: "workday",
    gate: (page, _employerUrl, normalizedUrl) =>
      verifyPageBeforeMutationGeneric(page, {
        isTrustedHost: isTrustedWorkdayHost,
        formMarkers: workdaySelectorsV1.formMarkers,
        ...(normalizedUrl ? { expectedUrl: normalizedUrl } : {}),
      }),
    submit: (page, opts) => workdaySubmit(page, opts),
    submitSelector: workdaySelectorsV1.wizard.submitButton,
    verifySubmission: (page, opts) => workdayVerifySubmission(page, opts),
    supportsEssayFill: false,
    supportsHealing: false,
  },
};
