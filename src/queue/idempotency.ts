import type { Db } from "../storage/db/client.js";

export type IdempotencyStatus =
  | "in_progress"
  | "completed"
  | "uncertain"
  | "failed";

export type IdempotencyRecord = {
  idempotency_key: string;
  status: IdempotencyStatus;
  resource_type: string | null;
  resource_id: string | null;
  result_ref: string | null;
  holder_run_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export class IdempotencyConflictError extends Error {
  constructor(
    message: string,
    readonly record: IdempotencyRecord,
  ) {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

export function getIdempotency(
  db: Db,
  key: string,
): IdempotencyRecord | undefined {
  return db
    .prepare("SELECT * FROM idempotency_keys WHERE idempotency_key = ?")
    .get(key) as IdempotencyRecord | undefined;
}

/**
 * Claim a key for execution. Returns existing completed result as skip.
 * Blocks uncertain and in_progress keys.
 */
export function claimIdempotencyKey(
  db: Db,
  key: string,
  opts: {
    holderRunId: string;
    resourceType?: string;
    resourceId?: string;
  },
): { action: "execute" } | { action: "skip"; record: IdempotencyRecord } {
  const claim = db.transaction(() => {
    const existing = getIdempotency(db, key);
    if (existing) {
      if (existing.status === "completed") {
        return { action: "skip" as const, record: existing };
      }
      if (existing.status === "uncertain") {
        throw new IdempotencyConflictError(
          `Idempotency key ${key} is uncertain — human review required before retry`,
          existing,
        );
      }
      if (existing.status === "in_progress") {
        throw new IdempotencyConflictError(
          `Idempotency key ${key} is already in progress`,
          existing,
        );
      }
      // failed — allow reclaim
    }

    const now = new Date().toISOString();
    if (existing?.status === "failed") {
      db.prepare(
        `UPDATE idempotency_keys
         SET status = 'in_progress', holder_run_id = ?, resource_type = ?,
             resource_id = ?, result_ref = NULL, updated_at = ?, completed_at = NULL
         WHERE idempotency_key = ?`,
      ).run(
        opts.holderRunId,
        opts.resourceType ?? null,
        opts.resourceId ?? null,
        now,
        key,
      );
    } else {
      db.prepare(
        `INSERT INTO idempotency_keys (
          idempotency_key, status, resource_type, resource_id, result_ref,
          holder_run_id, created_at, updated_at, completed_at
        ) VALUES (?, 'in_progress', ?, ?, NULL, ?, ?, ?, NULL)`,
      ).run(
        key,
        opts.resourceType ?? null,
        opts.resourceId ?? null,
        opts.holderRunId,
        now,
        now,
      );
    }

    return { action: "execute" as const };
  });

  return claim.immediate();
}

export function completeIdempotencyKey(
  db: Db,
  key: string,
  resultRef?: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE idempotency_keys
     SET status = 'completed', result_ref = ?, updated_at = ?, completed_at = ?
     WHERE idempotency_key = ?`,
  ).run(resultRef ?? null, now, now, key);
}

export function failIdempotencyKey(db: Db, key: string, resultRef?: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE idempotency_keys
     SET status = 'failed', result_ref = ?, updated_at = ?
     WHERE idempotency_key = ?`,
  ).run(resultRef ?? null, now, key);
}

export function markIdempotencyUncertain(
  db: Db,
  key: string,
  resultRef?: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE idempotency_keys
     SET status = 'uncertain', result_ref = ?, updated_at = ?
     WHERE idempotency_key = ?`,
  ).run(resultRef ?? null, now, key);
}

export function buildIdempotencyKey(
  kind: string,
  parts: Record<string, string>,
): string {
  const ordered = Object.keys(parts)
    .sort()
    .map((k) => `${k}=${parts[k] ?? ""}`)
    .join(";");
  return `${kind}:{${ordered}}`;
}
