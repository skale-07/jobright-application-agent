import type { Page } from "playwright";
import type { SubmissionAttempt, SubmissionReceipt } from "../ats/adapter.js";
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
  submit(page: Page): Promise<SubmissionAttempt>;
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
  greenhouse: {
    id: "greenhouse",
    gate: (page, employerUrl, normalizedUrl) =>
      verifyPageBeforeMutation(page, employerUrl, normalizedUrl ?? null),
    submit: (page) => greenhouseSubmit(page),
    verifySubmission: (page, opts) => greenhouseVerifySubmission(page, opts),
    supportsEssayFill: true,
    supportsHealing: true,
  },
  lever: {
    id: "lever",
    gate: (page) =>
      verifyPageBeforeMutationGeneric(page, {
        isTrustedHost: isTrustedLeverHost,
        formMarkers: leverSelectorsV1.formMarkers,
      }),
    submit: (page) => leverSubmit(page),
    verifySubmission: (page, opts) => leverVerifySubmission(page, opts),
    supportsEssayFill: false,
    supportsHealing: false,
  },
  ashby: {
    id: "ashby",
    gate: (page) =>
      verifyPageBeforeMutationGeneric(page, {
        isTrustedHost: isTrustedAshbyHost,
        formMarkers: ashbySelectorsV1.formMarkers,
      }),
    submit: (page) => ashbySubmit(page),
    verifySubmission: (page, opts) => ashbyVerifySubmission(page, opts),
    supportsEssayFill: false,
    supportsHealing: false,
  },
};
