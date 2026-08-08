/** Response shapes mirrored from src/console/ (hand-kept, small on purpose). */

export type Summary = {
  database: string;
  rollout_stage: number;
  dry_run: boolean;
  form_fill_enabled: boolean;
  submit_enabled: boolean;
  outlook_drafts_enabled: boolean;
  email_generation_enabled: boolean;
  email_send_enabled: boolean;
  applications_by_state: Array<{ state: string; n: number }>;
  open_review_items: number;
  auth: Array<{
    service: string;
    mode: string;
    ready: boolean;
    detail: string;
    last_status: string | null;
    last_validated_at: string | null;
  }>;
  sensitive_profile: unknown;
};

export type ApplicationRow = {
  id: string;
  state: string;
  route: string | null;
  attempt: number;
  updated_at: string;
  created_at: string;
  company: string | null;
  role: string | null;
  location: string | null;
  automation_excluded: boolean;
  has_open_review: boolean;
};

export type ApplicationsPage = { rows: ApplicationRow[]; total: number };

export type ReviewItemView = {
  id: string;
  application_id: string | null;
  kind: string;
  status: string;
  title: string;
  payload: Record<string, unknown> | null;
  resolution: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
};

export type TimelineEntry = {
  previous_state: string | null;
  next_state: string;
  timestamp: string;
  reason: string | null;
  attempt: number | null;
  run_id: string | null;
  artifacts: string[];
  warnings: string[];
};

export type ApplicationDetail = {
  application: Record<string, unknown>;
  job: Record<string, unknown>;
  timeline: TimelineEntry[];
  review_items: ReviewItemView[];
  submissions: Array<Record<string, unknown>>;
  materials: Array<Record<string, unknown>>;
  fill_runs: Array<Record<string, unknown>>;
  drafts: Array<Record<string, unknown>>;
  contacts_count: number;
  email_generations_count: number;
  artifact_links: string[];
};

export type FillOutcomesView = {
  summary: Record<string, unknown>;
  success_rates: Array<Record<string, unknown>>;
};

export type FlagsView = {
  ceiling: Record<string, boolean>;
  live_mode_available: boolean;
  always_forced: Record<string, unknown>;
};

export type RunStatus =
  | "pending"
  | "running"
  | "awaiting_confirmation"
  | "succeeded"
  | "failed"
  | "canceled"
  | "timed_out";

export type SubmitConfirmationSummary = {
  application_id: string;
  company: string | null;
  role: string | null;
  url: string;
  attempt: number;
  resume_sha256: string;
  resume_size_bytes: number;
  plan: {
    fillable_count: number;
    skipped_count: number;
    review_required_count: number;
  };
};

export type RunKind = "pipeline" | "nav" | "submit" | "discover" | "automation";

export type RunRecord = {
  id: string;
  kind: RunKind;
  params: Record<string, unknown>;
  granted_flags: string[];
  denied_flags: string[];
  status: RunStatus;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  exit_code: number | null;
  error: string | null;
  gates: Record<string, boolean> | null;
  pending_confirmation: {
    confirmation_id: string;
    summary: SubmitConfirmationSummary;
    requested_at: string;
    expires_at: string;
  } | null;
  report: unknown;
  log_seq: number;
};

export type LogLine = { seq: number; stream: "stdout" | "stderr"; line: string };

export type ArmStatus = {
  armed: boolean;
  arm_run_id: string | null;
  armed_until: string | null;
  seconds_remaining: number;
  max_submits: number;
  submits_used: number;
  max_apps: number;
  apps_started: number;
  discover_max: number;
  rediscover_every: number;
};
