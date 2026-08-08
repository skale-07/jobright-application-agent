type Tone = "ok" | "warn" | "danger" | "accent" | "purple" | "neutral";

const STATE_TONES: Record<string, Tone> = {
  COMPLETED: "ok",
  SUBMITTED: "ok",
  READY_TO_SUBMIT: "accent",
  SUBMITTING: "accent",
  QUEUED: "neutral",
  DISCOVERED: "neutral",
  FAILED_FINAL: "danger",
  FAILED_RETRYABLE: "warn",
  SUBMISSION_VERIFICATION_FAILED: "warn",
  ESSAY_REQUIRED: "warn",
  AUTH_REQUIRED: "warn",
  CAPTCHA_REQUIRED: "warn",
  AMBIGUOUS_FIELD: "warn",
  UNSUPPORTED_ATS: "warn",
  FILTERED_OUT: "neutral",
};

const RUN_TONES: Record<string, Tone> = {
  succeeded: "ok",
  running: "accent",
  pending: "neutral",
  awaiting_confirmation: "purple",
  failed: "danger",
  timed_out: "danger",
  canceled: "neutral",
};

const REVIEW_TONES: Record<string, Tone> = {
  UNCERTAIN_SUBMISSION: "warn",
  AUTH_REQUIRED: "warn",
  CAPTCHA_REQUIRED: "warn",
  UNSUPPORTED_ATS: "warn",
  AMBIGUOUS_FIELD: "warn",
  ESSAY: "purple",
  MANUAL: "neutral",
  DUPLICATE_RISK: "neutral",
  OPEN: "warn",
  IN_PROGRESS: "accent",
  RESOLVED: "ok",
  DISMISSED: "neutral",
};

export function StateBadge({
  value,
  kind = "state",
}: {
  value: string | null | undefined;
  kind?: "state" | "run" | "review";
}): JSX.Element {
  if (!value) return <span className="faint">—</span>;
  const table =
    kind === "run" ? RUN_TONES : kind === "review" ? REVIEW_TONES : STATE_TONES;
  const tone = table[value] ?? "neutral";
  return <span className={`badge ${tone}`}>{value}</span>;
}
