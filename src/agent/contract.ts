import { z } from "zod";

/**
 * The stdin/stdout JSON contract with the Python authoring sidecar
 * (agent/jobright_agent/author.py). This side is authoritative: sidecar
 * output that fails these schemas is rejected, never trusted.
 */
export const agentAuthoringTaskSchema = z.object({
  task_version: z.literal(1),
  task_type: z.literal("author").default("author"),
  url: z.string().url(),
  cdp_url: z.string().url(),
  allowed_domains: z.array(z.string()).min(1),
  timeout_ms: z.number().int().positive().max(300_000),
});

export type AgentAuthoringTask = z.infer<typeof agentAuthoringTaskSchema>;

/**
 * Phase 6a′ escalation: locate one field in page HTML supplied in the task.
 * HTML-payload based — no browser, no CDP, no LLM. The same seam a future
 * Workday agent loop (J2) plugs into with a richer task type.
 */
export const agentLocateFieldTaskSchema = z.object({
  task_version: z.literal(1),
  task_type: z.literal("locate_field"),
  field_label: z.string().min(1),
  field_type: z.string().min(1),
  /** Page HTML, capped by the caller. */
  html: z.string().min(1).max(600_000),
  timeout_ms: z.number().int().positive().max(120_000),
});

export type AgentLocateFieldTask = z.infer<typeof agentLocateFieldTaskSchema>;

export const agentFieldCandidateSchema = z.object({
  label: z.string(),
  type: z.string(),
  selector_candidates: z.array(z.string()).min(1),
  confidence: z.number().min(0).max(1),
});

export const agentAuthoringResultSchema = z.object({
  status: z.enum(["ok", "error"]),
  reason: z.string().optional(),
  field_candidates: z.array(agentFieldCandidateSchema),
  warnings: z.array(z.string()),
});

export type AgentAuthoringResult = z.infer<typeof agentAuthoringResultSchema>;

/**
 * Navigation task: reach the employer's application form starting from a
 * JobRight job page (or an intermediate wall). The sidecar attaches to the
 * operator's CDP Chrome — it never launches a browser — so a continuation
 * micro-turn is simply a fresh spawn with `resume` populated; cookies and
 * tabs persist in the Chrome between spawns. Navigation NEVER answers
 * application-form fields and NEVER clicks an application submit control.
 */
export const agentNavigateTaskSchema = z.object({
  task_version: z.literal(1),
  task_type: z.literal("navigate"),
  goal: z.string().min(1).max(2000),
  start_url: z.string().url(),
  cdp_url: z.string().url(),
  allowed_domains: z.array(z.string()).min(1).max(20),
  max_steps: z.number().int().positive().max(40),
  timeout_ms: z.number().int().positive().max(300_000),
  /** Secrets ride only here (stdin) — never into artifacts or logs. */
  credentials: z
    .object({
      available: z.boolean(),
      username: z.string().optional(),
      password: z.string().optional(),
    })
    .default({ available: false }),
  /** Whether the orchestrator can service a verification_email request. */
  gmail_available: z.boolean().default(false),
  /** Continuation micro-turn: reattach and inject the verification input. */
  resume: z
    .object({
      prior_run_id: z.string().min(1),
      prior_final_url: z.string().url(),
      injected: z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("verification_code"),
          code: z.string().min(4).max(12),
        }),
        z.object({
          kind: z.literal("magic_link"),
          url: z.string().url(),
        }),
      ]),
    })
    .optional(),
});

export type AgentNavigateTask = z.infer<typeof agentNavigateTaskSchema>;

export const agentNavigateResultSchema = z
  .object({
    status: z.enum(["ok", "needs_input", "error"]),
    final_url: z.string().url().nullable(),
    wall: z.enum([
      "none",
      "auth",
      "captcha",
      "phone_otp",
      "budget",
      "submit_risk",
    ]),
    steps_used: z.number().int().nonnegative(),
    domains_visited: z.array(z.string()).max(50),
    notes: z.array(z.string().max(500)).max(20),
    reason: z.string().optional(),
    need: z
      .object({
        kind: z.literal("verification_email"),
        /** Mailbox address the site says it mailed. */
        sent_to: z.string(),
        sender_hint: z.string().optional(),
        subject_hint: z.string().optional(),
        /** ISO timestamp — Gmail query lower bound. */
        requested_at: z.string(),
      })
      .optional(),
  })
  .superRefine((r, ctx) => {
    if (r.status === "needs_input" && !r.need) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "needs_input requires a `need` payload",
      });
    }
    if (r.status === "ok" && r.final_url === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ok requires a non-null final_url",
      });
    }
  });

export type AgentNavigateResult = z.infer<typeof agentNavigateResultSchema>;
