import { z } from "zod";
import dotenv from "dotenv";
import path from "node:path";
import {
  parseBrowserChannel,
  type BrowserChannel,
} from "../browser/launchOptions.js";

dotenv.config();

const boolFromEnv = z
  .union([z.boolean(), z.string()])
  .transform((v) => {
    if (typeof v === "boolean") return v;
    const s = v.trim().toLowerCase();
    return s === "1" || s === "true" || s === "yes";
  });

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  DATABASE_PATH: z.string().default("data/app.sqlite"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DRY_RUN: boolFromEnv.default(true),
  FORM_FILL_ENABLED: boolFromEnv.default(false),
  SUBMIT_ENABLED: boolFromEnv.default(false),
  SUBMIT_REQUIRES_LOCAL_CONFIRMATION: boolFromEnv.default(true),
  MAX_UNATTENDED_SUBMISSIONS_PER_RUN: z.coerce.number().int().nonnegative().default(0),
  OUTLOOK_DRAFTS_ENABLED: boolFromEnv.default(false),
  LINKEDIN_ENRICHMENT_ENABLED: boolFromEnv.default(false),
  JOBRIGHT_AUTOFILL_ENABLED: boolFromEnv.default(false),
  NATIVE_AUTOFILL_ENABLED: boolFromEnv.default(false),
  /** Phase 5.6H: generating/downloading a resume mutates JobRight. Fail closed. */
  MATERIALS_DOWNLOAD_ENABLED: boolFromEnv.default(false),
  /** Nav clicks Apply on live JobRight (mutates applied-state). Fail closed. */
  NAVIGATION_ENABLED: boolFromEnv.default(false),
  /** Gmail readonly OTP/magic-link retrieval during navigation. Fail closed. */
  GMAIL_VERIFICATION_ENABLED: boolFromEnv.default(false),
  /**
   * Read-only Outlook web mailbox scan for submit verification codes.
   * Navigation + DOM reads in the operator's session only — never
   * compose/send (sendGuards). Fail closed.
   */
  OUTLOOK_VERIFICATION_ENABLED: boolFromEnv.default(false),
  /**
   * Hard-stop inspection/pipeline on heuristic essay fields (`needs_essay` /
   * `ESSAY_REQUIRED`). Default off — the label heuristics false-positive on
   * EEO/combobox copy (e.g. "describe your race"). Free-text is still never
   * auto-filled (textarea refusal in approvedFillPlan). When enabled, only
   * REQUIRED essay fields stop the pipeline — optional textareas never block.
   */
  ESSAY_REQUIRED_GATE_ENABLED: boolFromEnv.default(false),
  /** Outreach email generation calls the OpenAI API (spend). Fail closed. */
  EMAIL_GENERATION_ENABLED: boolFromEnv.default(false),
  /** OpenAI key for outreach generation only. Never logged or artifacted. */
  OPENAI_API_KEY: z.string().optional(),
  /** Operator-confirmed OpenAI model id for outreach generation. */
  EMAIL_LLM_MODEL: z.string().default("gpt-5-mini"),
  /**
   * Anthropic key. When set it is the PREFERRED provider at every LLM
   * boundary (text generation and the nav sidecar); OpenAI becomes the
   * fallback. Never logged or artifacted.
   */
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Anthropic model id used when the Anthropic provider is active. */
  ANTHROPIC_LLM_MODEL: z.string().default("claude-opus-5"),
  /** Phase 6 J1: browser-use authoring sidecar. Fail closed. */
  AGENT_AUTHORING_ENABLED: boolFromEnv.default(false),
  SCREENER_LLM_MATCH_ENABLED: boolFromEnv.default(false),
  SCREENER_PREDICT_LLM_ENABLED: boolFromEnv.default(false),
  ARTIFACT_AUTOPUSH_ENABLED: boolFromEnv.default(false),
  ESSAY_DRAFT_ENABLED: boolFromEnv.default(false),
  /** Phase 6a': sidecar escalation when the in-process healer fails. Fail closed. */
  AGENT_FALLBACK_ENABLED: boolFromEnv.default(false),
  /**
   * L3 kill switch. The console automation worker (unattended apply while
   * armed) is refused unless this is set — regardless of any arm. Fail closed.
   */
  AUTOMATION_ENABLED: boolFromEnv.default(false),
  /** CDP endpoint of the operator-started debug Chrome (see chrome:debug:jobright). */
  AGENT_CDP_URL: z.string().default("http://127.0.0.1:9222"),
  /**
   * Hands-off cycle may LAUNCH the debug Chrome itself when the CDP
   * endpoint is unreachable (same executable + persistent profile as
   * chrome:debug:jobright, so logins survive). Fail closed — an
   * unattended process starting a browser is a mutation capability.
   */
  CDP_AUTOLAUNCH_ENABLED: boolFromEnv.default(false),
  DASHBOARD_HOST: z.string().default("127.0.0.1"),
  DASHBOARD_PORT: z.coerce.number().int().positive().default(8788),
  /** Operator console (frontend + guarded mutation API). Localhost only. */
  CONSOLE_HOST: z.string().default("127.0.0.1"),
  CONSOLE_PORT: z.coerce.number().int().positive().default(8899),
  CANDIDATE_DATA_KEY_NAME: z
    .string()
    .default("jobright-application-agent/candidate-data-key"),
  ARTIFACTS_DIR: z.string().default("artifacts"),
  PRIVATE_DIR: z.string().default("private"),
  /**
   * Fallback resume auto-attached to an application that reaches the
   * materials stage with none registered (used by unattended L3 sessions
   * so a fresh discovery does not dead-end on a missing resume). Plain
   * path, not a capability flag; auto-attach is a no-op when the file is
   * absent.
   */
  DEFAULT_RESUME_PATH: z.string().default("private/candidate/resumes/default.pdf"),
  JSONL_EVENTS_PATH: z.string().default("data/events/applications.jsonl"),
  /** chrome = system Google Chrome (needed for Google OAuth). chromium = bundled. */
  BROWSER_CHANNEL: z.string().default("chrome"),
});

export type AppConfig = {
  nodeEnv: string;
  databasePath: string;
  logLevel: "debug" | "info" | "warn" | "error";
  dryRun: boolean;
  formFillEnabled: boolean;
  submitEnabled: boolean;
  submitRequiresLocalConfirmation: boolean;
  maxUnattendedSubmissionsPerRun: number;
  outlookDraftsEnabled: boolean;
  linkedinEnrichmentEnabled: boolean;
  jobrightAutofillEnabled: boolean;
  nativeAutofillEnabled: boolean;
  materialsDownloadEnabled: boolean;
  navigationEnabled: boolean;
  gmailVerificationEnabled: boolean;
  outlookVerificationEnabled: boolean;
  essayRequiredGateEnabled: boolean;
  emailGenerationEnabled: boolean;
  /** Present only when the operator configured it; consumers must not log it. */
  openaiApiKey: string | undefined;
  emailLlmModel: string;
  /** Present only when the operator configured it; consumers must not log it. */
  anthropicApiKey: string | undefined;
  anthropicLlmModel: string;
  agentAuthoringEnabled: boolean;
  screenerLlmMatchEnabled: boolean;
  screenerPredictLlmEnabled: boolean;
  artifactAutopushEnabled: boolean;
  essayDraftEnabled: boolean;
  agentFallbackEnabled: boolean;
  automationEnabled: boolean;
  agentCdpUrl: string;
  cdpAutolaunchEnabled: boolean;
  dashboardHost: string;
  dashboardPort: number;
  consoleHost: string;
  consolePort: number;
  candidateDataKeyName: string;
  artifactsDir: string;
  privateDir: string;
  defaultResumePath: string;
  jsonlEventsPath: string;
  browserChannel: BrowserChannel;
  /** Always false — no send capability exists. */
  emailSendEnabled: false;
};

let cached: AppConfig | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);

  if (parsed.DASHBOARD_HOST !== "127.0.0.1" && parsed.DASHBOARD_HOST !== "localhost") {
    throw new Error(
      `DASHBOARD_HOST must be 127.0.0.1 or localhost (got ${parsed.DASHBOARD_HOST})`,
    );
  }
  if (parsed.CONSOLE_HOST !== "127.0.0.1" && parsed.CONSOLE_HOST !== "localhost") {
    throw new Error(
      `CONSOLE_HOST must be 127.0.0.1 or localhost (got ${parsed.CONSOLE_HOST})`,
    );
  }

  const forbiddenSendFlag = ["EMAIL", "SEND", "ENABLED"].join("_");
  if (env[forbiddenSendFlag] !== undefined) {
    throw new Error(
      `${forbiddenSendFlag} is forbidden. Outlook supports drafts only.`,
    );
  }
  const forbiddenGmailFlag = ["GMAIL", "SEND", "ENABLED"].join("_");
  if (env[forbiddenGmailFlag] !== undefined) {
    throw new Error(
      `${forbiddenGmailFlag} is forbidden. Gmail is readonly verification only.`,
    );
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    databasePath: path.resolve(parsed.DATABASE_PATH),
    logLevel: parsed.LOG_LEVEL,
    dryRun: parsed.DRY_RUN,
    formFillEnabled: parsed.FORM_FILL_ENABLED,
    submitEnabled: parsed.SUBMIT_ENABLED,
    submitRequiresLocalConfirmation: parsed.SUBMIT_REQUIRES_LOCAL_CONFIRMATION,
    maxUnattendedSubmissionsPerRun: parsed.MAX_UNATTENDED_SUBMISSIONS_PER_RUN,
    outlookDraftsEnabled: parsed.OUTLOOK_DRAFTS_ENABLED,
    linkedinEnrichmentEnabled: parsed.LINKEDIN_ENRICHMENT_ENABLED,
    jobrightAutofillEnabled: parsed.JOBRIGHT_AUTOFILL_ENABLED,
    nativeAutofillEnabled: parsed.NATIVE_AUTOFILL_ENABLED,
    materialsDownloadEnabled: parsed.MATERIALS_DOWNLOAD_ENABLED,
    navigationEnabled: parsed.NAVIGATION_ENABLED,
    gmailVerificationEnabled: parsed.GMAIL_VERIFICATION_ENABLED,
    outlookVerificationEnabled: parsed.OUTLOOK_VERIFICATION_ENABLED,
    essayRequiredGateEnabled: parsed.ESSAY_REQUIRED_GATE_ENABLED,
    emailGenerationEnabled: parsed.EMAIL_GENERATION_ENABLED,
    openaiApiKey: parsed.OPENAI_API_KEY,
    emailLlmModel: parsed.EMAIL_LLM_MODEL,
    anthropicApiKey: parsed.ANTHROPIC_API_KEY,
    anthropicLlmModel: parsed.ANTHROPIC_LLM_MODEL,
    agentAuthoringEnabled: parsed.AGENT_AUTHORING_ENABLED,
    screenerLlmMatchEnabled: parsed.SCREENER_LLM_MATCH_ENABLED,
    screenerPredictLlmEnabled: parsed.SCREENER_PREDICT_LLM_ENABLED,
    artifactAutopushEnabled: parsed.ARTIFACT_AUTOPUSH_ENABLED,
    essayDraftEnabled: parsed.ESSAY_DRAFT_ENABLED,
    agentFallbackEnabled: parsed.AGENT_FALLBACK_ENABLED,
    automationEnabled: parsed.AUTOMATION_ENABLED,
    agentCdpUrl: parsed.AGENT_CDP_URL,
    cdpAutolaunchEnabled: parsed.CDP_AUTOLAUNCH_ENABLED,
    dashboardHost: parsed.DASHBOARD_HOST,
    dashboardPort: parsed.DASHBOARD_PORT,
    consoleHost: parsed.CONSOLE_HOST,
    consolePort: parsed.CONSOLE_PORT,
    candidateDataKeyName: parsed.CANDIDATE_DATA_KEY_NAME,
    artifactsDir: path.resolve(parsed.ARTIFACTS_DIR),
    privateDir: path.resolve(parsed.PRIVATE_DIR),
    defaultResumePath: path.resolve(parsed.DEFAULT_RESUME_PATH),
    jsonlEventsPath: path.resolve(parsed.JSONL_EVENTS_PATH),
    browserChannel: parseBrowserChannel(parsed.BROWSER_CHANNEL),
    emailSendEnabled: false,
  };
}

export function getConfig(): AppConfig {
  if (!cached) {
    cached = loadConfig();
  }
  return cached;
}

export function resetConfigCache(): void {
  cached = undefined;
}

export function deriveRolloutStage(config: AppConfig): 1 | 2 | 3 | 4 | 5 {
  if (!config.formFillEnabled) return 1;
  if (!config.submitEnabled) return 2;
  if (config.submitRequiresLocalConfirmation) return 3;
  if (config.maxUnattendedSubmissionsPerRun > 0) return 4;
  return 5;
}
