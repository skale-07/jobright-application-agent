/**
 * The promote-if-it-worked loop: screener fills whose values PASSED live
 * verification (fill_field_outcomes.verify_match=1) but whose key has no
 * bank answer are suggested as ready-to-paste bank labels. The operator
 * still applies them by hand — a prediction that worked once earns a
 * suggestion, not a silent write into the answer file.
 */
import type { Db } from "../storage/db/client.js";
import { migrate, openDatabase } from "../storage/db/client.js";
import { screenerDef } from "./screeners.js";
import { tryLoadScreenerBank } from "./screenersIO.js";

export type ScreenerSuggestion = {
  key: string;
  suggested_answer: string;
  verified_count: number;
  last_seen: string;
};

export function suggestBankAdditions(opts: { db?: Db } = {}): ScreenerSuggestion[] {
  let ownedDb = false;
  const db =
    opts.db ??
    (() => {
      ownedDb = true;
      return openDatabase();
    })();
  try {
    migrate(db);
    const bank = tryLoadScreenerBank();
    const have = new Set(
      Object.entries(bank?.answers ?? {})
        .filter(([, v]) => v.trim() !== "")
        .map(([k]) => k),
    );
    const rows = db
      .prepare(
        `SELECT o.canonical_field AS canonical,
                COALESCE(o.selected_option, o.observed_redacted, o.expected_redacted) AS value,
                COUNT(*) AS n,
                MAX(r.created_at) AS last_seen
         FROM fill_field_outcomes o
         JOIN fill_runs r ON r.id = o.fill_run_id
         WHERE o.canonical_field LIKE 'screener:%' AND o.verify_match = 1
         GROUP BY o.canonical_field, value
         ORDER BY n DESC`,
      )
      .all() as Array<{
      canonical: string;
      value: string | null;
      n: number;
      last_seen: string;
    }>;

    const out: ScreenerSuggestion[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const key = row.canonical.slice("screener:".length).split(":")[0] ?? "";
      if (!key || seen.has(key) || have.has(key) || !row.value) continue;
      if (!screenerDef(key)) continue;
      seen.add(key);
      out.push({
        key,
        suggested_answer: row.value,
        verified_count: row.n,
        last_seen: row.last_seen,
      });
    }
    return out;
  } finally {
    if (ownedDb) db.close();
  }
}
