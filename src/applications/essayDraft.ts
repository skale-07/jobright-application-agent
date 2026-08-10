/**
 * Essay DRAFT assistant — the third sanctioned LLM boundary. It exists to
 * end the blank-page problem, not to write for the candidate: drafts are
 * generated from the operator's own about-me.md + the job posting, land
 * INSIDE the open ESSAY review item (payload.essay_drafts) and as
 * artifacts, and carry validation_level UNVERIFIED. The human edits or
 * approves in the review flow; only the approved text is ever filled
 * (via the existing saveHumanEssayAnswer path). Essays are still never
 * auto-filled — this module writes suggestions, never form values.
 *
 * Gated by ESSAY_DRAFT_ENABLED (fail closed) + an LLM key (Anthropic preferred, OpenAI fallback).
 */
import fs from "node:fs";
import path from "node:path";
import type { Db } from "../storage/db/client.js";
import { getConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import {
  listOpenReviewItems,
  updateReviewItemPayload,
  type ReviewItem,
} from "../queue/reviewItems.js";
import { ensureApplicationArtifactDirs } from "../storage/atomicJson.js";
import {
  hasLlmKey,
  LLM_KEY_HINT,
  makeLlmClient,
  type EmailLlmClient,
} from "../contacts/emailLlm.js";

export function aboutMePaths(): { aboutPath: string; examplePath: string } {
  const cfg = getConfig();
  return {
    aboutPath: path.join(cfg.privateDir, "candidate", "about-me.md"),
    examplePath: path.join(cfg.privateDir, "candidate", "about-me.example.md"),
  };
}

export function tryLoadAboutMe(): string | null {
  const { aboutPath } = aboutMePaths();
  if (!fs.existsSync(aboutPath)) return null;
  const text = fs.readFileSync(aboutPath, "utf8").trim();
  return text.length >= 80 ? text : null;
}

const SYSTEM_PROMPT = `You draft a job-application essay ANSWER for a candidate, in their first-person voice.
Hard rules:
- Use ONLY facts present in the candidate context and the job posting. Never invent projects, numbers, employers, or claims. If the context is thin, write a shorter draft rather than padding.
- 80-220 words. Direct, concrete, specific. No buzzwords, no "passionate", no exclamation marks, no placeholder brackets.
- Answer the actual question asked. If the question mentions the company's product, connect to it only through facts in the context.
Output STRICT JSON: {"draft": string}.`;

export type EssayDraftResult = {
  field_id: string;
  question: string;
  status: "drafted" | "rejected" | "error";
  draft_path: string | null;
  notes: string[];
};

export type EssayDraftReport = {
  application_id: string;
  drafts: EssayDraftResult[];
  review_item_id: string | null;
  notes: string[];
};

/** Deterministic checks the model output must survive — never trusted raw. */
export function validateDraft(draft: unknown): { ok: boolean; reason: string } {
  if (typeof draft !== "string") return { ok: false, reason: "not a string" };
  const words = draft.trim().split(/\s+/).filter(Boolean).length;
  if (words < 40) return { ok: false, reason: `too short (${words} words)` };
  if (words > 260) return { ok: false, reason: `too long (${words} words)` };
  if (/\[(insert|your|todo|placeholder|name)/i.test(draft)) {
    return { ok: false, reason: "contains placeholder brackets" };
  }
  if (/as an ai|language model/i.test(draft)) {
    return { ok: false, reason: "model self-reference" };
  }
  return { ok: true, reason: "ok" };
}

export async function generateEssayDrafts(input: {
  db: Db;
  applicationId: string;
  client?: EmailLlmClient;
}): Promise<EssayDraftReport> {
  const cfg = getConfig();
  if (!cfg.essayDraftEnabled) {
    throw new Error("ESSAY_DRAFT_ENABLED=false — refusing essay draft generation");
  }
  const about = tryLoadAboutMe();
  if (!about) {
    throw new Error(
      "private/candidate/about-me.md missing or too short — copy about-me.example.md and write your context first",
    );
  }
  const { db, applicationId } = input;

  const report: EssayDraftReport = {
    application_id: applicationId,
    drafts: [],
    review_item_id: null,
    notes: [],
  };

  // Essay questions come from the app's open review items: the ESSAY item
  // (payload.essays) and completeness-gate items (payload.unanswered
  // textareas). Nothing is scraped live here — drafting is offline.
  const items = listOpenReviewItems(db).filter(
    (i) => i.application_id === applicationId,
  );
  const questions: Array<{ field_id: string; question: string; item: ReviewItem }> = [];
  for (const item of items) {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(
        (item as unknown as { payload_json: string }).payload_json ?? "{}",
      ) as Record<string, unknown>;
    } catch {
      payload = {};
    }
    const essays = payload["essays"];
    if (Array.isArray(essays)) {
      for (const e of essays) {
        const o = e as { field_id?: unknown; label?: unknown };
        if (typeof o.field_id === "string" && typeof o.label === "string") {
          questions.push({ field_id: o.field_id, question: o.label, item });
        }
      }
    }
    const unanswered = payload["unanswered"];
    if (Array.isArray(unanswered)) {
      for (const u of unanswered) {
        const o = u as { label?: unknown; control?: unknown };
        if (o.control === "textarea" && typeof o.label === "string") {
          questions.push({
            field_id: `completeness:${o.label.slice(0, 40)}`,
            question: o.label,
            item,
          });
        }
      }
    }
  }
  if (questions.length === 0) {
    report.notes.push("no open essay questions on this application's review items");
    return report;
  }

  const job = db
    .prepare(
      `SELECT j.company, j.role, j.raw_json FROM jobs j
       JOIN applications a ON a.job_id = j.id WHERE a.id = ?`,
    )
    .get(applicationId) as
    | { company: string; role: string; raw_json: string }
    | undefined;

  const client = input.client ?? makeLlmClient();
  const dirs = ensureApplicationArtifactDirs(applicationId);
  const essayDir = path.join(dirs.root, "essays");
  fs.mkdirSync(essayDir, { recursive: true });

  const draftsByField: Record<string, string> = {};
  const seen = new Set<string>();
  for (const q of questions) {
    if (seen.has(q.question)) continue;
    seen.add(q.question);
    const result: EssayDraftResult = {
      field_id: q.field_id,
      question: q.question,
      status: "error",
      draft_path: null,
      notes: [],
    };
    report.drafts.push(result);
    try {
      const { text } = await client.generateJson({
        system: SYSTEM_PROMPT,
        user: JSON.stringify({
          question: q.question,
          company: job?.company ?? null,
          role: job?.role ?? null,
          candidate_context: about,
        }),
      });
      const parsed = JSON.parse(text) as { draft?: unknown };
      const check = validateDraft(parsed.draft);
      if (!check.ok) {
        result.status = "rejected";
        result.notes.push(`draft rejected: ${check.reason}`);
        continue;
      }
      const draft = (parsed.draft as string).trim();
      const safe = q.field_id.replace(/[^a-z0-9_-]/gi, "_").slice(0, 60);
      const outPath = path.join(essayDir, `draft-${safe}.md`);
      fs.writeFileSync(
        outPath,
        `# DRAFT (UNVERIFIED) — edit before approving\n\n` +
          `Question: ${q.question}\n\n---\n\n${draft}\n`,
        "utf8",
      );
      draftsByField[q.field_id] = draft;
      result.status = "drafted";
      result.draft_path = outPath;
      report.review_item_id = q.item.id;
    } catch (err) {
      result.notes.push(
        err instanceof Error ? err.message.slice(0, 200) : String(err),
      );
    }
  }

  // Attach suggestions to the review item so the console shows them next
  // to the questions. Suggestion only — approval still goes through the
  // human essay-answer path.
  const drafted = Object.keys(draftsByField);
  if (drafted.length > 0 && report.review_item_id) {
    updateReviewItemPayload(db, report.review_item_id, {
      essay_drafts: draftsByField,
      essay_drafts_validation_level: "UNVERIFIED",
      essay_drafts_note:
        "LLM suggestions from your about-me.md — edit/approve via the essay answer flow; never auto-filled",
    });
  }

  logger.info("essay drafts generated (suggestions only)", {
    service: "essays",
    action: "essay_draft",
    metadata: {
      application_id: applicationId,
      drafted: drafted.length,
      rejected: report.drafts.filter((d) => d.status === "rejected").length,
      errors: report.drafts.filter((d) => d.status === "error").length,
    },
  });
  return report;
}

export type EssayDraftBatchReport = {
  applications_considered: number;
  drafts_generated: number;
  notes: string[];
};

/**
 * Autonomous entry point: draft every open essay question across a set of
 * applications (the armed worker calls this after the session loop, like
 * the outreach batch). Fail-open per app — drafting problems become notes,
 * never session failures. Flag-off is a single named note, not an error:
 * autonomy degrades loudly, it doesn't crash.
 */
export async function generateEssayDraftBatch(input: {
  db: Db;
  applicationIds: string[];
  client?: EmailLlmClient;
}): Promise<EssayDraftBatchReport> {
  const cfg = getConfig();
  const report: EssayDraftBatchReport = {
    applications_considered: 0,
    drafts_generated: 0,
    notes: [],
  };
  if (!cfg.essayDraftEnabled) {
    report.notes.push("essay drafts skipped: ESSAY_DRAFT_ENABLED off");
    return report;
  }
  if (!input.client && !hasLlmKey(cfg)) {
    report.notes.push(`essay drafts skipped: no LLM key (${LLM_KEY_HINT})`);
    return report;
  }
  if (!tryLoadAboutMe()) {
    report.notes.push(
      "essay drafts skipped: private/candidate/about-me.md missing or too short",
    );
    return report;
  }
  for (const applicationId of input.applicationIds) {
    try {
      const r = await generateEssayDrafts({
        db: input.db,
        applicationId,
        ...(input.client ? { client: input.client } : {}),
      });
      if (r.drafts.length === 0) continue;
      report.applications_considered += 1;
      const drafted = r.drafts.filter((d) => d.status === "drafted").length;
      report.drafts_generated += drafted;
      if (drafted > 0) {
        report.notes.push(
          `essay drafts ${applicationId}: ${drafted}/${r.drafts.length} drafted (UNVERIFIED, in review)`,
        );
      }
      for (const d of r.drafts.filter((x) => x.status !== "drafted")) {
        report.notes.push(
          `essay draft ${applicationId} "${d.question.slice(0, 50)}": ${d.status} ${d.notes.join("; ").slice(0, 100)}`,
        );
      }
    } catch (err) {
      report.notes.push(
        `essay drafts ${applicationId} failed: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`,
      );
    }
  }
  return report;
}
