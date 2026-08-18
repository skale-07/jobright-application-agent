/**
 * Offline LLM healer for submit-control misses. Reads the CTA inventories
 * that every FAILED_BEFORE_CLICK now records (submit_attempts +
 * artifacts), asks a model to PROPOSE selector-cascade patches, and lands
 * the proposals as artifacts + review items. Hard boundaries:
 *
 *   - PROPOSE-ONLY. This module never touches the selector registries and
 *     never runs during a live session — it is an offline CLI step, and a
 *     human applies (or rejects) each patch by hand. A healer's
 *     self-report carries no validation level (UNVERIFIED by definition).
 *   - Gated by AGENT_AUTHORING_ENABLED + an LLM key (Anthropic preferred, then OpenAI, then Kimi/Moonshot); fail closed.
 *   - Input is already PII-safe (tag/type/text/aria of buttons); nothing
 *     else is sent to the model.
 */
import fs from "node:fs";
import path from "node:path";
import type { Db } from "../storage/db/client.js";
import { getConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { writeJsonAtomic } from "../storage/atomicJson.js";
import { upsertOpenReviewItem } from "../queue/reviewItems.js";
import {
  makeLlmClient,
  type EmailLlmClient,
} from "../contacts/emailLlm.js";

export type SubmitMissEvidence = {
  attempt_id: string;
  application_id: string;
  ats: string;
  url_host: string | null;
  reason: string | null;
  cta_inventory: unknown[];
};

export type SelectorProposal = {
  ats: string;
  url_host: string | null;
  application_id: string;
  /** Additions the human may fold into the registry — never auto-applied. */
  proposed_name_pattern: string | null;
  proposed_css: string | null;
  rationale: string;
  confidence: "low" | "medium" | "high";
  validation_level: "UNVERIFIED";
};

export type HealProposalsReport = {
  misses_considered: number;
  proposals: SelectorProposal[];
  proposals_path: string | null;
  review_item_ids: string[];
  notes: string[];
};

const SYSTEM_PROMPT = `You repair submit-button selector cascades for job-application forms.
Input: an ATS id, a host, and an inventory of candidate CTAs (tag/type/text/aria/disabled/visible) captured when the ranked cascade found no submit control.
Output STRICT JSON: {"proposals":[{"proposed_name_pattern": string|null, "proposed_css": string|null, "rationale": string, "confidence": "low"|"medium"|"high"}]}.
Rules: propose ONLY for a control that clearly submits the application; NEVER propose wizard controls (Next/Continue/Back/Save) or anything ambiguous — return an empty proposals array instead. Patterns must be narrow (accessible-name regex source or a CSS selector), not catch-alls like 'button'.`;

/** Latest miss with an inventory per (ats, host) — one proposal per surface. */
export function collectSubmitMisses(
  db: Db,
  limit = 10,
): SubmitMissEvidence[] {
  const rows = db
    .prepare(
      `SELECT id, application_id, ats, url_host, reason, report_artifact_relpath
       FROM submit_attempts
       WHERE outcome = 'FAILED_BEFORE_CLICK' AND cta_inventory_count > 0
       ORDER BY created_at DESC`,
    )
    .all() as Array<{
    id: string;
    application_id: string;
    ats: string;
    url_host: string | null;
    reason: string | null;
    report_artifact_relpath: string | null;
  }>;

  const out: SubmitMissEvidence[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.ats}::${row.url_host ?? "?"}`;
    if (seen.has(key)) continue;
    let inventory: unknown[] = [];
    if (row.report_artifact_relpath && fs.existsSync(row.report_artifact_relpath)) {
      try {
        const report = JSON.parse(
          fs.readFileSync(row.report_artifact_relpath, "utf8"),
        ) as { reason?: string };
        const m = /cta inventory: (\[.*\])/.exec(report.reason ?? "");
        if (m?.[1]) inventory = JSON.parse(m[1]) as unknown[];
      } catch {
        inventory = [];
      }
    }
    if (inventory.length === 0 && row.reason) {
      const m = /cta inventory: (\[.*\])/.exec(row.reason);
      if (m?.[1]) {
        try {
          inventory = JSON.parse(m[1]) as unknown[];
        } catch {
          inventory = [];
        }
      }
    }
    if (inventory.length === 0) continue;
    seen.add(key);
    out.push({
      attempt_id: row.id,
      application_id: row.application_id,
      ats: row.ats,
      url_host: row.url_host,
      reason: row.reason,
      cta_inventory: inventory,
    });
    if (out.length >= limit) break;
  }
  return out;
}

function parseProposals(
  text: string,
  miss: SubmitMissEvidence,
): SelectorProposal[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const list = (parsed as { proposals?: unknown[] }).proposals;
  if (!Array.isArray(list)) return [];
  const out: SelectorProposal[] = [];
  for (const p of list.slice(0, 3)) {
    const o = p as Record<string, unknown>;
    const name = typeof o["proposed_name_pattern"] === "string" ? o["proposed_name_pattern"] : null;
    const css = typeof o["proposed_css"] === "string" ? o["proposed_css"] : null;
    if (!name && !css) continue;
    // Refuse catch-alls and wizard words at the validation layer too —
    // the model is told the rules, but the gate does not trust it.
    const wizard = /next|continue|back|previous|save/i;
    if ((name && wizard.test(name)) || (css && /^(button|a|input)$/i.test(css.trim()))) {
      continue;
    }
    out.push({
      ats: miss.ats,
      url_host: miss.url_host,
      application_id: miss.application_id,
      proposed_name_pattern: name,
      proposed_css: css,
      rationale:
        typeof o["rationale"] === "string" ? o["rationale"].slice(0, 500) : "",
      confidence:
        o["confidence"] === "high" || o["confidence"] === "medium"
          ? o["confidence"]
          : "low",
      validation_level: "UNVERIFIED",
    });
  }
  return out;
}

export async function proposeSubmitSelectorPatches(input: {
  db: Db;
  client?: EmailLlmClient;
  limit?: number;
  now?: Date;
}): Promise<HealProposalsReport> {
  const cfg = getConfig();
  if (!cfg.agentAuthoringEnabled) {
    throw new Error(
      "AGENT_AUTHORING_ENABLED=false — refusing healer proposal generation",
    );
  }
  const client = input.client ?? makeLlmClient();
  const { db } = input;

  const report: HealProposalsReport = {
    misses_considered: 0,
    proposals: [],
    proposals_path: null,
    review_item_ids: [],
    notes: [],
  };

  const misses = collectSubmitMisses(db, input.limit ?? 10);
  report.misses_considered = misses.length;
  if (misses.length === 0) {
    report.notes.push("no submit misses with inventories — nothing to heal");
    return report;
  }

  for (const miss of misses) {
    try {
      const { text } = await client.generateJson({
        system: SYSTEM_PROMPT,
        user: JSON.stringify({
          ats: miss.ats,
          host: miss.url_host,
          cta_inventory: miss.cta_inventory.slice(0, 20),
        }),
      });
      const proposals = parseProposals(text, miss);
      if (proposals.length === 0) {
        report.notes.push(
          `${miss.ats}@${miss.url_host ?? "?"}: model proposed nothing usable`,
        );
        continue;
      }
      report.proposals.push(...proposals);
    } catch (err) {
      report.notes.push(
        `${miss.ats}@${miss.url_host ?? "?"}: generation failed — ${
          err instanceof Error ? err.message.slice(0, 200) : String(err)
        }`,
      );
    }
  }

  if (report.proposals.length > 0) {
    const ts = (input.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
    const outDir = path.join(cfg.artifactsDir, "heal-proposals", ts);
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, "proposals.json");
    writeJsonAtomic(outPath, {
      generated_at: new Date().toISOString(),
      validation_level: "UNVERIFIED",
      apply_rule:
        "human-applied only: fold accepted patterns into the versioned selector registries and add a fixture test before the next armed run",
      proposals: report.proposals,
    });
    report.proposals_path = outPath;

    for (const p of report.proposals) {
      const { item } = upsertOpenReviewItem(db, {
        applicationId: p.application_id,
        kind: "MANUAL",
        title: `Submit selector proposal (${p.ats}${p.url_host ? `@${p.url_host}` : ""}) — review & apply by hand`,
        payload: {
          proposal: p,
          proposals_path: outPath,
          validation_level: "UNVERIFIED",
        },
      });
      report.review_item_ids.push(item.id);
    }
  }

  logger.info("submit inventory healer finished (propose-only)", {
    service: "heal",
    action: "submit_inventory_heal",
    metadata: {
      misses_considered: report.misses_considered,
      proposals: report.proposals.length,
      review_items: report.review_item_ids.length,
      proposals_path: report.proposals_path,
    },
  });
  return report;
}
