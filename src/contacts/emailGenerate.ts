import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "../storage/db/client.js";
import { getConfig, resetConfigCache } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { getApplication, transitionApplication } from "../queue/stateMachine.js";
import { upsertOpenReviewItem } from "../queue/reviewItems.js";
import { loadPersona, type Persona } from "../candidate/personas.js";
import { getContact, type ContactRow } from "./repository.js";
import { hasLlmKey, LLM_KEY_HINT, type EmailLlmClient } from "./emailLlm.js";

export const OUTREACH_PROMPT_VERSION = "outreach-email.v2";
/**
 * v2 (operator template 2026-08-18): ONE subject form for every contact —
 * "JHU sophomore interested in [Company / Role]". The two exports remain
 * because callers branch on source_category for the metadata flag, but
 * they now carry the same prefix by design.
 */
export const ALUM_SUBJECT_PREFIX = "JHU sophomore interested in ";
export const NON_ALUM_SUBJECT_PREFIX = "JHU sophomore interested in ";

const TEMPLATE_PLACEHOLDER = "PASTE_USER_APPROVED_EMAIL_TEMPLATE_HERE";

export class TemplateNotConfiguredError extends Error {
  constructor(templatePath: string) {
    super(
      `Outreach template at ${templatePath} is a placeholder or empty — fill it in before generating.`,
    );
    this.name = "TemplateNotConfiguredError";
  }
}

/**
 * Outreach generation is a spend surface (external API) — fail closed.
 */
export function assertEmailGenerationAllowed(): void {
  resetConfigCache();
  const cfg = getConfig();
  if (!cfg.emailGenerationEnabled) {
    throw new Error(
      `EMAIL_GENERATION_ENABLED=false — refusing outreach generation. Set it to true (and ${LLM_KEY_HINT}) to enable.`,
    );
  }
  if (!hasLlmKey(cfg)) {
    throw new Error(
      `no LLM key set (${LLM_KEY_HINT}) — outreach generation refused. Add one to .env.`,
    );
  }
}

export function loadOutreachTemplate(
  templatePath = path.join(process.cwd(), "prompts", "outreach-email.v2.md"),
): string {
  if (!fs.existsSync(templatePath)) {
    throw new TemplateNotConfiguredError(templatePath);
  }
  const text = fs.readFileSync(templatePath, "utf8");
  if (text.includes(TEMPLATE_PLACEHOLDER) || text.trim().length < 100) {
    throw new TemplateNotConfiguredError(templatePath);
  }
  return text;
}

export const emailOutputSchema = z.object({
  subject: z.string().min(5),
  body_text: z.string().min(50),
  used_alum_subject: z.boolean(),
  persona_projects_used: z.array(z.string()).min(1),
});

export type GeneratedEmail = z.infer<typeof emailOutputSchema>;

export type EmailContext = {
  contact: {
    /** Null for email-only contacts (insider triage) — greet "Hi there,". */
    name: string | null;
    title: string | null;
    company: string | null;
    source_category: string;
  };
  /** description grounds [team/product/background]; null when unknown. */
  job: { company: string; role: string; description: string | null };
  persona: Persona;
};

/** Pure prompt assembly — testable without any client. */
export function buildEmailPrompt(input: {
  template: string;
  context: EmailContext;
}): { system: string; user: string } {
  const schemaDescription = JSON.stringify({
    subject: "string",
    body_text: "string (plain text, greeting through signature)",
    used_alum_subject: "boolean",
    persona_projects_used: ["exact persona project names used in the bullets"],
  });
  const system = [
    input.template,
    "",
    "## Output schema (JSON object, nothing else)",
    schemaDescription,
  ].join("\n");
  const user = JSON.stringify(
    {
      contact: input.context.contact,
      job: input.context.job,
      persona: input.context.persona,
    },
    null,
    2,
  );
  return { system, user };
}

export type EmailValidationResult = {
  valid: boolean;
  violations: string[];
};

const REFERRAL_CLAIMS =
  /referred by|told (?:me )?to contact|suggested (?:that )?i reach out|was introduced/i;
const ALUM_CLAIMS = /fellow (?:hopkins|blue jay|jhu)|as a fellow/i;

/**
 * Deterministic post-generation checks. The model's output is never trusted:
 * every rule the prompt states is re-verified here, and a violation means
 * REJECTED — no draft, review item instead.
 */
export function validateGeneratedEmail(input: {
  output: GeneratedEmail;
  context: EmailContext;
}): EmailValidationResult {
  const violations: string[] = [];
  const { output, context } = input;
  const isAlum = context.contact.source_category === "school";

  const expectedPrefix = isAlum ? ALUM_SUBJECT_PREFIX : NON_ALUM_SUBJECT_PREFIX;
  if (!output.subject.startsWith(expectedPrefix)) {
    violations.push(
      `subject must start with "${expectedPrefix}" for source_category=${context.contact.source_category}`,
    );
  }
  if (output.used_alum_subject !== isAlum) {
    violations.push("used_alum_subject does not match contact source_category");
  }
  if (
    context.job.company &&
    !output.subject.toLowerCase().includes(context.job.company.toLowerCase())
  ) {
    violations.push("subject must name the company");
  }

  const personaProjectNames = new Set(
    context.persona.projects.map((p) => p.name),
  );
  for (const used of output.persona_projects_used) {
    if (!personaProjectNames.has(used)) {
      violations.push(`project "${used}" is not in the persona — invented`);
    }
    if (
      personaProjectNames.has(used) &&
      !output.body_text.includes(used)
    ) {
      violations.push(`project "${used}" claimed as used but absent from body`);
    }
  }

  if (REFERRAL_CLAIMS.test(output.body_text)) {
    violations.push("body claims a referral/introduction");
  }
  if (!isAlum && ALUM_CLAIMS.test(output.body_text)) {
    violations.push("body claims a school tie for a non-school contact");
  }
  const firstName = context.contact.name?.split(/\s+/)[0] ?? "";
  if (firstName && !output.body_text.includes(firstName)) {
    violations.push("body does not greet the contact by first name");
  }
  if (!firstName && !/^hi there,/im.test(output.body_text)) {
    violations.push(
      'nameless contact must be greeted with exactly "Hi there," — a guessed name is an invented fact',
    );
  }
  if (!output.body_text.includes("Shubham Kale")) {
    violations.push("body missing signature");
  }
  if (!output.body_text.includes("github.com/skale-07")) {
    violations.push("body missing the github.com/skale-07 signature link");
  }
  if (/\[[^\]]{1,60}\]/.test(output.body_text) || /\[[^\]]{1,60}\]/.test(output.subject)) {
    violations.push("unfilled [bracket] placeholder left in the email");
  }
  // Placeholder tokens without brackets (REPLACE_PROJECT_ONE slid past the
  // bracket check in a live 2026-08-18 draft and was VALIDATED).
  const tokenPlaceholder = /REPLACE_[A-Z0-9_]+|\bPLACEHOLDER\b|\bLOREM IPSUM\b/i;
  if (
    tokenPlaceholder.test(output.body_text) ||
    tokenPlaceholder.test(output.subject)
  ) {
    violations.push("unfilled placeholder token left in the email");
  }

  return { valid: violations.length === 0, violations };
}

export type EmailGenerationResult = {
  email_generation_id: string | null;
  contact_id: string;
  validation_status: "VALIDATED" | "REJECTED";
  subject: string | null;
  body_text: string | null;
  model: string | null;
  violations: string[];
  review_item_id: string | null;
  application_state: string;
};

/**
 * Generate one outreach email for one contact via the injected client
 * (makeLlmClient() in production, a stub in tests) and persist the result.
 * REJECTED output never reaches a draft.
 */
export async function generateEmailForContact(input: {
  db: Db;
  applicationId: string;
  contactId: string;
  client: EmailLlmClient;
  personaId?: string;
  /** Reserved for future per-contact enrichment context. */
  extraContext?: Record<string, unknown>;
}): Promise<EmailGenerationResult> {
  assertEmailGenerationAllowed();
  const { db, applicationId } = input;

  const app = getApplication(db, applicationId);
  if (!app) throw new Error(`Unknown application: ${applicationId}`);
  // COMPLETED is the pipeline's skip when EMAIL_GENERATION_ENABLED was
  // off ("run email:generate manually"). It is terminal — generate
  // anyway, do not rewind the state machine.
  const allowed = new Set([
    "CONTACTS_EXTRACTED",
    "EMAIL_GENERATING",
    "EMAIL_GENERATED",
    "DRAFT_CREATING",
    "DRAFT_CREATED",
    "COMPLETED",
  ]);
  if (!allowed.has(app.state)) {
    throw new Error(
      `Email generation requires CONTACTS_EXTRACTED+ (got ${app.state})`,
    );
  }

  const contact = getContact(db, input.contactId);
  if (!contact || contact.application_id !== applicationId) {
    throw new Error(`Contact ${input.contactId} not found on this application`);
  }
  // Email-only contacts (insider triage) have no name — the template's
  // rules greet them "Hi there," rather than guessing from the address.

  const job = db
    .prepare(
      `SELECT j.company, j.role, j.description_text FROM jobs j
       JOIN applications a ON a.job_id = j.id WHERE a.id = ?`,
    )
    .get(applicationId) as {
    company: string;
    role: string;
    description_text: string | null;
  };

  const template = loadOutreachTemplate();
  const persona = loadPersona(input.personaId ?? "default");
  const context: EmailContext = {
    contact: {
      name: contact.name,
      title: contact.title,
      company: contact.company,
      source_category: contact.source_category ?? "unknown",
    },
    job: {
      company: job.company,
      role: job.role,
      // Grounds [team/product/background]; bounded so one long posting
      // cannot blow up every generation payload.
      description: job.description_text?.slice(0, 2_000) ?? null,
    },
    persona,
  };

  if (app.state === "CONTACTS_EXTRACTED") {
    transitionApplication(db, {
      applicationId,
      nextState: "EMAIL_GENERATING",
      reason: "outreach generation started",
    });
  }

  const prompt = buildEmailPrompt({ template, context });
  const raw = await input.client.generateJson(prompt);

  let output: GeneratedEmail | null = null;
  const violations: string[] = [];
  try {
    output = emailOutputSchema.parse(JSON.parse(raw.text));
  } catch (err) {
    violations.push(
      `output failed schema validation: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
    );
  }
  if (output) {
    const check = validateGeneratedEmail({ output, context });
    violations.push(...check.violations);
  }

  const status: "VALIDATED" | "REJECTED" =
    output && violations.length === 0 ? "VALIDATED" : "REJECTED";

  const generationId = randomUUID();
  db.prepare(
    `INSERT INTO email_generations (
      id, application_id, contact_id, prompt_version, model, subject,
      body_text, body_html, payload_json, validation_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
    ON CONFLICT(application_id, contact_id, prompt_version) DO UPDATE SET
      model = excluded.model,
      subject = excluded.subject,
      body_text = excluded.body_text,
      payload_json = excluded.payload_json,
      validation_status = excluded.validation_status`,
  ).run(
    generationId,
    applicationId,
    input.contactId,
    OUTREACH_PROMPT_VERSION,
    raw.model,
    output?.subject ?? null,
    output?.body_text ?? null,
    JSON.stringify({
      context: {
        contact: context.contact,
        job: context.job,
        persona_id: persona.persona_id,
      },
      raw_output: raw.text.slice(0, 8000),
      violations,
    }),
    status,
    new Date().toISOString(),
  );
  const row = db
    .prepare(
      `SELECT id FROM email_generations
       WHERE application_id = ? AND contact_id = ? AND prompt_version = ?`,
    )
    .get(applicationId, input.contactId, OUTREACH_PROMPT_VERSION) as {
    id: string;
  };

  let reviewItemId: string | null = null;
  if (status === "REJECTED") {
    const { item } = upsertOpenReviewItem(db, {
      applicationId,
      kind: "MANUAL",
      title: `Outreach generation rejected for contact ${contact.name}`,
      payload: { contact_id: input.contactId, violations },
    });
    reviewItemId = item.id;
  } else if (getApplication(db, applicationId)?.state === "EMAIL_GENERATING") {
    transitionApplication(db, {
      applicationId,
      nextState: "EMAIL_GENERATED",
      reason: "validated outreach email available",
    });
  }

  logger.info("outreach generation finished", {
    service: "outreach",
    action: "email_generate",
    metadata: {
      application_id: applicationId,
      contact_id: input.contactId,
      status,
      model: raw.model,
      violation_count: violations.length,
    },
  });

  return {
    email_generation_id: row?.id ?? null,
    contact_id: input.contactId,
    validation_status: status,
    subject: status === "VALIDATED" ? (output?.subject ?? null) : null,
    body_text: status === "VALIDATED" ? (output?.body_text ?? null) : null,
    model: raw.model,
    violations,
    review_item_id: reviewItemId,
    application_state: getApplication(db, applicationId)?.state ?? "?",
  };
}
