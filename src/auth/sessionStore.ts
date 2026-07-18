import type { Db } from "../storage/db/client.js";
import type { AuthValidationResult, ServiceName, SessionPersistenceMode } from "./types.js";
import { getServiceAuthConfig } from "./serviceRegistry.js";

export type ServiceSessionRow = {
  service: ServiceName;
  persistence_mode: SessionPersistenceMode;
  storage_state_path: string | null;
  persistent_profile_path: string | null;
  last_validated_at: string | null;
  last_status: string | null;
  metadata_json: string;
};

export function upsertServiceSessionStatus(
  db: Db,
  input: {
    service: ServiceName;
    mode: SessionPersistenceMode;
    validation: AuthValidationResult;
    metadata?: Record<string, unknown>;
  },
): void {
  const cfg = getServiceAuthConfig(input.service);
  db.prepare(
    `INSERT INTO service_sessions (
      service, persistence_mode, storage_state_path, persistent_profile_path,
      last_validated_at, last_status, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(service) DO UPDATE SET
      persistence_mode = excluded.persistence_mode,
      storage_state_path = excluded.storage_state_path,
      persistent_profile_path = excluded.persistent_profile_path,
      last_validated_at = excluded.last_validated_at,
      last_status = excluded.last_status,
      metadata_json = excluded.metadata_json`,
  ).run(
    input.service,
    input.mode,
    cfg.storageStatePath,
    cfg.persistentProfilePath,
    input.validation.checkedAt,
    input.validation.status,
    JSON.stringify({
      ok: input.validation.ok,
      reason: input.validation.reason,
      url: input.validation.url,
      ...(input.metadata ?? {}),
    }),
  );
}

export function getServiceSessionRow(
  db: Db,
  service: ServiceName,
): ServiceSessionRow | undefined {
  return db
    .prepare(`SELECT * FROM service_sessions WHERE service = ?`)
    .get(service) as ServiceSessionRow | undefined;
}

export function listServiceSessionRows(db: Db): ServiceSessionRow[] {
  return db
    .prepare(`SELECT * FROM service_sessions ORDER BY service`)
    .all() as ServiceSessionRow[];
}
