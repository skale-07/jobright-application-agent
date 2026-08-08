import fs from "node:fs";
import path from "node:path";
import type { Db } from "../storage/db/client.js";
import { getApplication } from "../queue/stateMachine.js";
import { getConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { saveVerifiedResume } from "./resumeDownload.js";

export type RegisteredMaterial = {
  material_id: string;
  application_id: string;
  path: string;
  sha256: string;
  size_bytes: number;
  label: string | null;
};

/**
 * Register a pre-written (operator-supplied) domain resume as this
 * application's resume material. Replaces live JobRight generation, which was
 * descoped. No browser, no gate: reading a local file mutates nothing external.
 * Persistence guarantees are identical to the download path because both go
 * through saveVerifiedResume (verify -> atomic write -> re-verify -> upsert).
 */
export function registerResumeMaterial(input: {
  db: Db;
  applicationId: string;
  filePath: string;
  label?: string;
}): RegisteredMaterial {
  const app = getApplication(input.db, input.applicationId);
  if (!app) {
    throw new Error(`Unknown application: ${input.applicationId}`);
  }

  const abs = path.resolve(input.filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Resume file not found: ${abs}`);
  }
  const pdfBytes = fs.readFileSync(abs);

  const saved = saveVerifiedResume({
    db: input.db,
    applicationId: input.applicationId,
    pdfBytes,
    metadata: {
      source: "operator_registered",
      original_path: abs,
      label: input.label ?? null,
    },
  });

  logger.info("resume material registered", {
    service: "jobright",
    action: "materials_register",
    metadata: {
      application_id: input.applicationId,
      sha256: saved.sha256,
      size_bytes: saved.size_bytes,
      label: input.label ?? null,
    },
  });

  return {
    material_id: saved.material_id,
    application_id: input.applicationId,
    path: saved.path,
    sha256: saved.sha256,
    size_bytes: saved.size_bytes,
    label: input.label ?? null,
  };
}

export type EnsureResumeResult = "already" | "attached" | "no_default";

/**
 * Guarantee an application has a resume material when possible, using the
 * configured default resume as a fallback. No-op when one is already
 * registered; attaches the default (label "default") when the file exists;
 * reports "no_default" (loudly, for the caller to surface) when it does
 * not. This is what lets an unattended L3 session process freshly
 * discovered applications without dead-ending at the materials stage.
 */
export function ensureResumeForApplication(
  db: Db,
  applicationId: string,
): EnsureResumeResult {
  if (getRegisteredResume(db, applicationId)) return "already";
  const defaultPath = getConfig().defaultResumePath;
  if (!fs.existsSync(defaultPath)) {
    logger.warn("no default resume to auto-attach", {
      service: "jobright",
      action: "ensure_resume",
      metadata: { application_id: applicationId, default_resume_path: defaultPath },
    });
    return "no_default";
  }
  registerResumeMaterial({
    db,
    applicationId,
    filePath: defaultPath,
    label: "default",
  });
  return "attached";
}

/** The verified resume path for an application, or null when none registered. */
export function getRegisteredResume(
  db: Db,
  applicationId: string,
): { path: string; sha256: string; size_bytes: number } | null {
  const row = db
    .prepare(
      `SELECT path, sha256, size_bytes FROM materials
       WHERE application_id = ? AND kind = 'resume' AND verified = 1`,
    )
    .get(applicationId) as
    | { path: string; sha256: string; size_bytes: number }
    | undefined;
  return row ?? null;
}
