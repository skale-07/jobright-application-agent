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
  /** Outreach email generation calls the OpenAI API (spend). Fail closed. */
  EMAIL_GENERATION_ENABLED: boolFromEnv.default(false),
  /** OpenAI key for outreach generation only. Never logged or artifacted. */
  OPENAI_API_KEY: z.string().optional(),
  /** Operator-confirmed OpenAI model id for outreach generation. */
  EMAIL_LLM_MODEL: z.string().default("gpt-5-mini"),
  /** Phase 6 J1: browser-use authoring sidecar. Fail closed. */
  AGENT_AUTHORING_ENABLED: boolFromEnv.default(false),
  /** Phase 6a': sidecar escalation when the in-process healer fails. Fail closed. */
  AGENT_FALLBACK_ENABLED: boolFromEnv.default(false),
  /** CDP endpoint of the operator-started debug Chrome (see chrome:debug:jobright). */
  AGENT_CDP_URL: z.string().default("http://127.0.0.1:9222"),
  DASHBOARD_HOST: z.string().default("127.0.0.1"),
  DASHBOARD_PORT: z.coerce.number().int().positive().default(8788),
  CANDIDATE_DATA_KEY_NAME: z
    .string()
    .default("jobright-application-agent/candidate-data-key"),
  ARTIFACTS_DIR: z.string().default("artifacts"),
  PRIVATE_DIR: z.string().default("private"),
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
  emailGenerationEnabled: boolean;
  /** Present only when the operator configured it; consumers must not log it. */
  openaiApiKey: string | undefined;
  emailLlmModel: string;
  agentAuthoringEnabled: boolean;
  agentFallbackEnabled: boolean;
  agentCdpUrl: string;
  dashboardHost: string;
  dashboardPort: number;
  candidateDataKeyName: string;
  artifactsDir: string;
  privateDir: string;
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
    emailGenerationEnabled: parsed.EMAIL_GENERATION_ENABLED,
    openaiApiKey: parsed.OPENAI_API_KEY,
    emailLlmModel: parsed.EMAIL_LLM_MODEL,
    agentAuthoringEnabled: parsed.AGENT_AUTHORING_ENABLED,
    agentFallbackEnabled: parsed.AGENT_FALLBACK_ENABLED,
    agentCdpUrl: parsed.AGENT_CDP_URL,
    dashboardHost: parsed.DASHBOARD_HOST,
    dashboardPort: parsed.DASHBOARD_PORT,
    candidateDataKeyName: parsed.CANDIDATE_DATA_KEY_NAME,
    artifactsDir: path.resolve(parsed.ARTIFACTS_DIR),
    privateDir: path.resolve(parsed.PRIVATE_DIR),
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
