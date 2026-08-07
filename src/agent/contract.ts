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
