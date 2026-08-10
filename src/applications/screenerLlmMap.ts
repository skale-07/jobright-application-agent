/**
 * LLM assist for the ONE step models are allowed to touch in screener
 * handling: mapping a page label to a registry key. The model sees labels,
 * page options, and registry key DESCRIPTIONS — never the operator's
 * answers, never profile data. Its output is only trusted after
 * validation: the key must exist in the registry, and the eventual answer
 * must still resolve deterministically (option match or park) in
 * screenerMatch.ts. Mappings are cached per normalized label, so a label
 * costs at most one call ever — and the cache doubles as training data.
 *
 * Gated by SCREENER_LLM_MATCH_ENABLED (fail closed) + an LLM key (Anthropic preferred, OpenAI fallback).
 * Fail-open operationally: any error just means "no mapping" and the
 * field parks for review as it would have anyway.
 */
import { createHash } from "node:crypto";
import type { Db } from "../storage/db/client.js";
import { migrate, openDatabase } from "../storage/db/client.js";
import { getConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import {
  hasLlmKey,
  makeLlmClient,
  type EmailLlmClient,
} from "../contacts/emailLlm.js";
import { SCREENER_REGISTRY } from "../candidate/screeners.js";
import { normalizeScreenerLabel } from "../candidate/screenerMatch.js";

let migratedFor: Db | null = null;
function ensureMigrated(db: Db): void {
  if (migratedFor !== db) {
    migrate(db);
    migratedFor = db;
  }
}

export function labelFingerprint(label: string): string {
  return createHash("sha256")
    .update(normalizeScreenerLabel(label))
    .digest("hex")
    .slice(0, 32);
}

export type LabelToMap = {
  label: string;
  options?: string[] | undefined;
};

export type ScreenerKeyMapping = {
  label: string;
  key: string | null;
  source: "cache" | "llm";
};

const SYSTEM_PROMPT = `You classify job-application screener questions.
Input: a list of question labels (with their answer options when present) and a registry of screener keys with descriptions.
Output STRICT JSON: {"mappings":[{"label": string, "key": string|null}]} — one entry per input label, in order.
Rules: pick a key ONLY when the label clearly asks that registry question; anything ambiguous, essay-like ("why", "tell us", "describe"), demographic (gender/race/veteran/disability), or unlisted maps to null. Never invent keys.`;

function readCache(db: Db, labels: LabelToMap[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const stmt = db.prepare(
    `SELECT screener_key FROM screener_label_mappings WHERE label_fingerprint = ?`,
  );
  for (const l of labels) {
    const row = stmt.get(labelFingerprint(l.label)) as
      | { screener_key: string | null }
      | undefined;
    if (row !== undefined) out.set(l.label, row.screener_key);
  }
  return out;
}

function writeCache(
  db: Db,
  entries: Array<{ label: string; key: string | null; source: string }>,
  ats: string | null,
): void {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO screener_label_mappings
       (label_fingerprint, label, ats, screener_key, source, confidence, created_at)
     VALUES (?, ?, ?, ?, ?, 'medium', ?)`,
  );
  const now = new Date().toISOString();
  for (const e of entries) {
    stmt.run(
      labelFingerprint(e.label),
      normalizeScreenerLabel(e.label),
      ats,
      e.key,
      e.source,
      now,
    );
  }
}

/**
 * Map labels the deterministic patterns missed. Batched: one model call
 * for the whole form's unknowns. Returns only labels that got a mapping
 * (from cache or model) — absent means "park as before".
 */
export async function mapScreenerLabels(input: {
  labels: LabelToMap[];
  ats?: string | null;
  db?: Db;
  client?: EmailLlmClient;
}): Promise<ScreenerKeyMapping[]> {
  const cfg = getConfig();
  if (!cfg.screenerLlmMatchEnabled || input.labels.length === 0) return [];

  let ownedDb = false;
  const db =
    input.db ??
    (() => {
      ownedDb = true;
      return openDatabase();
    })();
  try {
    ensureMigrated(db);
    const results: ScreenerKeyMapping[] = [];
    const cached = readCache(db, input.labels);
    const toAsk: LabelToMap[] = [];
    for (const l of input.labels) {
      if (cached.has(l.label)) {
        results.push({ label: l.label, key: cached.get(l.label) ?? null, source: "cache" });
      } else {
        toAsk.push(l);
      }
    }
    if (toAsk.length === 0) return results;
    if (!hasLlmKey(cfg) && !input.client) {
      return results; // flag on but no key: cache-only mode
    }

    const client = input.client ?? makeLlmClient();
    const validKeys = new Set(SCREENER_REGISTRY.map((d) => d.key));
    try {
      const { text } = await client.generateJson({
        system: SYSTEM_PROMPT,
        user: JSON.stringify({
          registry: SCREENER_REGISTRY.map((d) => ({
            key: d.key,
            description: d.description,
          })),
          questions: toAsk.map((l) => ({
            label: l.label,
            options: (l.options ?? []).slice(0, 12),
          })),
        }),
      });
      const parsed = JSON.parse(text) as {
        mappings?: Array<{ label?: unknown; key?: unknown }>;
      };
      const byLabel = new Map<string, string | null>();
      for (const m of parsed.mappings ?? []) {
        if (typeof m.label !== "string") continue;
        const key =
          typeof m.key === "string" && validKeys.has(m.key) ? m.key : null;
        byLabel.set(normalizeScreenerLabel(m.label), key);
      }
      const fresh: Array<{ label: string; key: string | null; source: string }> = [];
      for (const l of toAsk) {
        const key = byLabel.get(normalizeScreenerLabel(l.label)) ?? null;
        results.push({ label: l.label, key, source: "llm" });
        fresh.push({ label: l.label, key, source: "llm" });
      }
      writeCache(db, fresh, input.ats ?? null);
    } catch (err) {
      logger.warn("screener llm mapping failed (fail-open: park as before)", {
        service: "screeners",
        action: "llm_map_error",
        metadata: {
          labels: toAsk.length,
          error: err instanceof Error ? err.message.slice(0, 200) : String(err),
        },
      });
    }
    return results;
  } finally {
    if (ownedDb) db.close();
  }
}
