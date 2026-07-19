import { randomUUID } from "node:crypto";
import type { Db } from "../storage/db/client.js";

export type LeaseRecord = {
  id: string;
  resource_type: string;
  resource_id: string;
  holder_run_id: string;
  acquired_at: string;
  expires_at: string;
  metadata_json: string;
};

export class LeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaseError";
  }
}

export function acquireLease(
  db: Db,
  opts: {
    resourceType: string;
    resourceId: string;
    holderRunId: string;
    ttlMs: number;
    metadata?: Record<string, unknown>;
  },
): LeaseRecord {
  const claim = db.transaction(() => {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const expiresAt = new Date(now + opts.ttlMs).toISOString();

    const existing = db
      .prepare(
        `SELECT * FROM leases WHERE resource_type = ? AND resource_id = ?`,
      )
      .get(opts.resourceType, opts.resourceId) as LeaseRecord | undefined;

    if (existing) {
      if (
        existing.expires_at > nowIso &&
        existing.holder_run_id !== opts.holderRunId
      ) {
        throw new LeaseError(
          `Lease held by ${existing.holder_run_id} until ${existing.expires_at}`,
        );
      }
      db.prepare(
        `UPDATE leases
         SET holder_run_id = ?, acquired_at = ?, expires_at = ?, metadata_json = ?
         WHERE id = ?`,
      ).run(
        opts.holderRunId,
        nowIso,
        expiresAt,
        JSON.stringify(opts.metadata ?? {}),
        existing.id,
      );
      return db
        .prepare(`SELECT * FROM leases WHERE id = ?`)
        .get(existing.id) as LeaseRecord;
    }

    const id = randomUUID();
    db.prepare(
      `INSERT INTO leases (
        id, resource_type, resource_id, holder_run_id, acquired_at, expires_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      opts.resourceType,
      opts.resourceId,
      opts.holderRunId,
      nowIso,
      expiresAt,
      JSON.stringify(opts.metadata ?? {}),
    );

    return db.prepare(`SELECT * FROM leases WHERE id = ?`).get(id) as LeaseRecord;
  });

  return claim.immediate();
}

export function releaseLease(
  db: Db,
  opts: { resourceType: string; resourceId: string; holderRunId: string },
): void {
  db.prepare(
    `DELETE FROM leases
     WHERE resource_type = ? AND resource_id = ? AND holder_run_id = ?`,
  ).run(opts.resourceType, opts.resourceId, opts.holderRunId);
}

export function purgeExpiredLeases(
  db: Db,
  nowIso = new Date().toISOString(),
): number {
  const result = db.prepare(`DELETE FROM leases WHERE expires_at <= ?`).run(nowIso);
  return result.changes;
}
