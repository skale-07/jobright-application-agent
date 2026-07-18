import { z } from "zod";
import dotenv from "dotenv";
import path from "node:path";

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
  DASHBOARD_HOST: z.string().default("127.0.0.1"),
  DASHBOARD_PORT: z.coerce.number().int().positive().default(8788),
  CANDIDATE_DATA_KEY_NAME: z
    .string()
    .default("jobright-application-agent/candidate-data-key"),
  ARTIFACTS_DIR: z.string().default("artifacts"),
  PRIVATE_DIR: z.string().default("private"),
  JSONL_EVENTS_PATH: z.string().default("data/events/applications.jsonl"),
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
  dashboardHost: string;
  dashboardPort: number;
  candidateDataKeyName: string;
  artifactsDir: string;
  privateDir: string;
  jsonlEventsPath: string;
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

  // Hard ban: never honor a send-enabled flag even if present in env
  const forbiddenSendFlag = ["EMAIL", "SEND", "ENABLED"].join("_");
  if (env[forbiddenSendFlag] !== undefined) {
    throw new Error(
      `${forbiddenSendFlag} is forbidden. Outlook supports drafts only.`,
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
    dashboardHost: parsed.DASHBOARD_HOST,
    dashboardPort: parsed.DASHBOARD_PORT,
    candidateDataKeyName: parsed.CANDIDATE_DATA_KEY_NAME,
    artifactsDir: path.resolve(parsed.ARTIFACTS_DIR),
    privateDir: path.resolve(parsed.PRIVATE_DIR),
    jsonlEventsPath: path.resolve(parsed.JSONL_EVENTS_PATH),
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

/** Rollout stage derived from flags (documentation helper). */
export function deriveRolloutStage(config: AppConfig): 1 | 2 | 3 | 4 | 5 {
  if (!config.formFillEnabled) return 1;
  if (!config.submitEnabled) return 2;
  if (config.submitRequiresLocalConfirmation) return 3;
  if (config.maxUnattendedSubmissionsPerRun > 0) return 4;
  return 5;
}
