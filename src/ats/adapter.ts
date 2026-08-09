import type { Page } from "playwright";

export type DetectionResult = {
  matched: boolean;
  confidence: number;
  atsId: string;
  evidence: string[];
};

export type DiscoveredField = {
  id: string;
  label: string;
  helpText?: string;
  type:
    | "text"
    | "textarea"
    | "select"
    | "radio"
    | "checkbox"
    | "file"
    | "date"
    | "unknown";
  required: boolean;
  options?: string[];
  currentValue?: unknown;
  maxLength?: number;
  minLength?: number;
  name?: string;
  inputId?: string;
};

export type ApplicationInspection = {
  ats: string;
  adapter_version: number;
  url: string;
  title: string;
  requires_login: boolean;
  captcha_detected: boolean;
  account_creation_detected: boolean;
  fields: DiscoveredField[];
  warnings: string[];
};

export type AutofillAttemptResult = {
  attempted: boolean;
  settled: boolean;
  notes: string[];
};

export type FormResetResult = {
  reset: boolean;
  notes: string[];
};

export type ResolvedApplicationAnswers = Record<string, unknown>;

export type FieldFillMeta = {
  field_id: string;
  /** Canonical when known — helps join verify rows. */
  canonical_field?: string | null;
  control_kind?:
    | "text"
    | "combobox"
    | "native_select"
    | "button_group"
    | "file"
    | "unknown";
  selected_option?: string | null;
  /** Option match path: exact | synonym | unique_substring | ci_exact */
  match_via?: string | null;
  notes?: string[];
  options_sample?: string[];
};

export type FillResult = {
  filled: string[];
  skipped: string[];
  errors: string[];
  /** Per-field interaction metadata (combobox picks, control kinds). */
  field_meta?: FieldFillMeta[];
};

export type UploadVerification = {
  field: string;
  path: string;
  filename: string;
  size_bytes: number;
  verified: boolean;
  evidence: string;
};

export type FormVerificationResult = {
  passed: boolean;
  fields: Array<{
    canonical_field: string;
    expected: unknown;
    observed: unknown;
    match: boolean;
  }>;
  uploads: UploadVerification[];
  warnings: string[];
};

export type SubmissionAttempt = {
  clicked: boolean;
  notes: string[];
};

/**
 * Click-commit seam for submit implementations: called AFTER the submit
 * control is resolved, visible, and enabled — immediately before the click.
 * Returning false withholds the click (clicked=false, note names the gate).
 * This is where the unattended submission budget is consumed, so a slot is
 * only ever spent on an attempt that could actually click (a resolve miss
 * or disabled control no longer burns budget).
 */
export type SubmitClickOptions = {
  beforeClick?: () => boolean | Promise<boolean>;
};

/** The note emitted when beforeClick withholds the click — callers match on it. */
export const CLICK_WITHHELD_NOTE = "click withheld by pre-click gate";

export type SubmissionReceipt = {
  submitted: boolean;
  submitted_at: string;
  confirmation_url: string;
  confirmation_text: string;
  application_identifier: string | null;
  screenshot_path: string;
};

/**
 * ATS adapter contract. Phase 4 implements detect/inspect/discoverFields.
 * Fill/submit arrive in later phases; stubs must not submit.
 */
export interface ApplicationAdapter {
  readonly id: string;
  readonly version: number;

  detect(input: { url: string; html: string; title?: string }): Promise<DetectionResult>;

  inspect(input: {
    url: string;
    html: string;
    title?: string;
  }): Promise<ApplicationInspection>;

  discoverFields(input: { html: string }): Promise<DiscoveredField[]>;

  attemptJobRightAutofill?(page: Page): Promise<AutofillAttemptResult>;
  resetForm?(page: Page): Promise<FormResetResult>;
  fill?(
    page: Page,
    resolvedAnswers: ResolvedApplicationAnswers,
  ): Promise<FillResult>;
  uploadResume?(page: Page, resumePath: string): Promise<UploadVerification>;
  uploadCoverLetter?(
    page: Page,
    coverLetterPath: string,
  ): Promise<UploadVerification>;
  verify?(
    page: Page,
    expected: ResolvedApplicationAnswers,
  ): Promise<FormVerificationResult>;
  submit?(page: Page): Promise<SubmissionAttempt>;
  verifySubmission?(page: Page): Promise<SubmissionReceipt>;
}
