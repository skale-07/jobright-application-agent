import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Download, Page } from "playwright";
import type { Db } from "../storage/db/client.js";
import { applicationArtifactDir } from "../storage/atomicJson.js";
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  failIdempotencyKey,
  getIdempotency,
} from "../queue/idempotency.js";
import { upsertOpenReviewItem } from "../queue/reviewItems.js";
import { jobrightSelectorsV1 } from "./selectors/v1.js";
import { verifyPdfDownload, type DownloadVerification } from "./jobDetails.js";

/** Synthetic fixture is ~45 bytes; reject empty/garbage below this. */
export const MIN_RESUME_PDF_BYTES = 20;

export const RESUME_MATERIAL_KIND = "resume";

export type ResumeDownloadOptions = {
  applicationId: string;
  downloadDir: string;
  /** Required for idempotency key. */
  jobDescriptionHash: string;
  /** Required for idempotency key (e.g. base resume content hash or version tag). */
  baseResumeVersion: string;
  db: Db;
  holderRunId?: string;
  /** Override click target; defaults to Improve My Resume. */
  clickSelector?: "improve" | "align-submit";
};

export type ResumeDownloadResult = {
  status: "downloaded" | "skipped" | "failed";
  path?: string;
  sha256?: string;
  size_bytes?: number;
  verified: boolean;
  idempotency_key: string;
  evidence: string;
  review_item_id?: string;
};

export function resumeIdempotencyKey(input: {
  applicationId: string;
  jobDescriptionHash: string;
  baseResumeVersion: string;
}): string {
  return `resume:${input.applicationId}:${input.jobDescriptionHash}:${input.baseResumeVersion}`;
}

export function materialsDirForApplication(applicationId: string): string {
  const dir = path.join(applicationArtifactDir(applicationId), "materials");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function resumeArtifactPath(
  applicationId: string,
  sha256: string,
): string {
  const sha8 = sha256.slice(0, 8);
  return path.join(
    materialsDirForApplication(applicationId),
    `resume-${sha8}.pdf`,
  );
}

/**
 * Verify PDF magic (%PDF-), min size, and sha256.
 * Stricter than verifyPdfDownload (requires %PDF- prefix and min bytes).
 */
export function verifyResumePdfBuffer(
  buf: Buffer,
  filePath = "resume.pdf",
): DownloadVerification {
  const size_bytes = buf.byteLength;
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const magic = buf.subarray(0, 5).toString("utf8");
  const isPdf = magic === "%PDF-";
  const verified = isPdf && size_bytes >= MIN_RESUME_PDF_BYTES;
  return {
    path: filePath,
    filename: path.basename(filePath),
    size_bytes,
    sha256,
    verified,
    evidence: verified
      ? `PDF magic %PDF- present and size >= ${MIN_RESUME_PDF_BYTES}`
      : !isPdf
        ? `Missing %PDF- magic (got ${JSON.stringify(magic)})`
        : `PDF too small (${size_bytes} < ${MIN_RESUME_PDF_BYTES})`,
  };
}

export function verifyResumePdfFile(filePath: string): DownloadVerification {
  if (!fs.existsSync(filePath)) {
    return {
      path: filePath,
      filename: path.basename(filePath),
      size_bytes: 0,
      sha256: "",
      verified: false,
      evidence: "File does not exist",
    };
  }
  return verifyResumePdfBuffer(fs.readFileSync(filePath), filePath);
}

/** Atomic write: temp in same dir then rename. */
export function atomicWriteFile(destPath: string, data: Buffer): void {
  const dir = path.dirname(destPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(destPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, destPath);
}

export function upsertResumeMaterial(
  db: Db,
  input: {
    applicationId: string;
    path: string;
    sha256: string;
    sizeBytes: number;
    metadata?: Record<string, unknown>;
  },
): { id: string } {
  const now = new Date().toISOString();
  const existing = db
    .prepare(
      `SELECT id FROM materials WHERE application_id = ? AND kind = ?`,
    )
    .get(input.applicationId, RESUME_MATERIAL_KIND) as
    | { id: string }
    | undefined;

  const id = existing?.id ?? randomUUID();
  const metadata_json = JSON.stringify(input.metadata ?? {});

  if (existing) {
    db.prepare(
      `UPDATE materials
       SET path = ?, sha256 = ?, size_bytes = ?, verified = 1,
           metadata_json = ?, created_at = COALESCE(created_at, ?)
       WHERE id = ?`,
    ).run(
      input.path,
      input.sha256,
      input.sizeBytes,
      metadata_json,
      now,
      id,
    );
  } else {
    db.prepare(
      `INSERT INTO materials (
        id, application_id, kind, path, sha256, size_bytes, verified,
        metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      id,
      input.applicationId,
      RESUME_MATERIAL_KIND,
      input.path,
      input.sha256,
      input.sizeBytes,
      metadata_json,
      now,
    );
  }
  return { id };
}

/**
 * Persist a verified resume buffer to the application materials dir + SQLite.
 */
export function saveVerifiedResume(input: {
  db: Db;
  applicationId: string;
  pdfBytes: Buffer;
  metadata?: Record<string, unknown>;
}): {
  path: string;
  sha256: string;
  size_bytes: number;
  material_id: string;
  verification: DownloadVerification;
} {
  const verification = verifyResumePdfBuffer(input.pdfBytes);
  if (!verification.verified) {
    throw new Error(`Resume PDF verification failed: ${verification.evidence}`);
  }
  const dest = resumeArtifactPath(input.applicationId, verification.sha256);
  atomicWriteFile(dest, input.pdfBytes);
  // Re-verify on disk (catches partial writes)
  const onDisk = verifyResumePdfFile(dest);
  if (!onDisk.verified || onDisk.sha256 !== verification.sha256) {
    throw new Error(
      `Resume PDF on-disk verification failed: ${onDisk.evidence}`,
    );
  }
  const { id } = upsertResumeMaterial(input.db, {
    applicationId: input.applicationId,
    path: dest,
    sha256: verification.sha256,
    sizeBytes: verification.size_bytes,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
  return {
    path: dest,
    sha256: verification.sha256,
    size_bytes: verification.size_bytes,
    material_id: id,
    verification: onDisk,
  };
}

async function findResumeDownloadLocator(
  page: Page,
  which: "improve" | "align-submit" = "improve",
): Promise<{ click: () => Promise<void> }> {
  if (which === "align-submit") {
    const btn = page.locator(jobrightSelectorsV1.jobDetail.resumeAlignSubmit).first();
    if (!(await btn.isVisible().catch(() => false))) {
      throw new Error("Resume align/submit control not visible");
    }
    return { click: () => btn.click() };
  }

  const btn = page.getByRole(jobrightSelectorsV1.jobDetail.improveResume.role, {
    name: jobrightSelectorsV1.jobDetail.improveResume.name,
  });
  if (await btn.first().isVisible().catch(() => false)) {
    return { click: () => btn.first().click() };
  }

  const fallback = page.getByRole("button", {
    name: /improve.*resume|download.*resume|resume.*download/i,
  });
  if (await fallback.first().isVisible().catch(() => false)) {
    return { click: () => fallback.first().click() };
  }

  const link = page.getByRole("link", {
    name: /improve.*resume|download.*resume/i,
  });
  if (await link.first().isVisible().catch(() => false)) {
    return { click: () => link.first().click() };
  }

  throw new Error("Improve/download resume control not visible");
}

async function assertResumeDownloadControlVisible(
  page: Page,
  which: "improve" | "align-submit" = "improve",
): Promise<void> {
  await findResumeDownloadLocator(page, which);
}

async function clickResumeDownloadControl(
  page: Page,
  which: "improve" | "align-submit" = "improve",
): Promise<void> {
  const target = await findResumeDownloadLocator(page, which);
  await target.click();
}

async function savePlaywrightDownload(
  download: Download,
  downloadDir: string,
): Promise<string> {
  fs.mkdirSync(downloadDir, { recursive: true });
  const suggested =
    download.suggestedFilename()?.replace(/[^\w.\-]+/g, "_") || "resume.pdf";
  const dest = path.join(
    downloadDir,
    `dl-${Date.now()}-${suggested.endsWith(".pdf") ? suggested : `${suggested}.pdf`}`,
  );
  await download.saveAs(dest);
  return dest;
}

function markResumeFailure(
  db: Db,
  key: string,
  applicationId: string,
  reason: string,
): string {
  failIdempotencyKey(db, key, reason);
  const { item } = upsertOpenReviewItem(db, {
    applicationId,
    kind: "MANUAL",
    title: "Resume download failed",
    payload: { reason, idempotency_key: key },
  });
  return item.id;
}

/**
 * Click Improve/Download resume, wait for Playwright download, verify PDF,
 * atomically store under artifacts/applications/{id}/materials/resume-{sha8}.pdf,
 * upsert materials row, and gate with resume idempotency.
 */
export async function downloadAndVerifyResume(
  page: Page,
  options: ResumeDownloadOptions,
): Promise<ResumeDownloadResult> {
  const key = resumeIdempotencyKey({
    applicationId: options.applicationId,
    jobDescriptionHash: options.jobDescriptionHash,
    baseResumeVersion: options.baseResumeVersion,
  });
  const holderRunId = options.holderRunId ?? `resume-${randomUUID()}`;

  try {
    const claim = claimIdempotencyKey(options.db, key, {
      holderRunId,
      resourceType: "materials",
      resourceId: options.applicationId,
    });

    if (claim.action === "skip") {
      const row = options.db
        .prepare(
          `SELECT path, sha256, size_bytes FROM materials
           WHERE application_id = ? AND kind = ?`,
        )
        .get(options.applicationId, RESUME_MATERIAL_KIND) as
        | { path: string; sha256: string; size_bytes: number }
        | undefined;
      const pathRef = row?.path ?? claim.record.result_ref;
      return {
        status: "skipped",
        verified: true,
        idempotency_key: key,
        evidence: "Idempotency key already completed — skipped download",
        ...(pathRef ? { path: pathRef } : {}),
        ...(row?.sha256 ? { sha256: row.sha256 } : {}),
        ...(row?.size_bytes !== undefined
          ? { size_bytes: row.size_bytes }
          : {}),
      };
    }

    // Confirm control before arming download waiter (avoids orphaned waitForEvent)
    await assertResumeDownloadControlVisible(
      page,
      options.clickSelector ?? "improve",
    );

    const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
    await clickResumeDownloadControl(page, options.clickSelector ?? "improve");
    const download = await downloadPromise;
    const tempPath = await savePlaywrightDownload(download, options.downloadDir);

    // Prefer strict resume checks; fall back evidence from legacy helper if needed
    const verification = verifyResumePdfFile(tempPath);
    if (!verification.verified) {
      const legacy = verifyPdfDownload(tempPath);
      const reviewId = markResumeFailure(
        options.db,
        key,
        options.applicationId,
        verification.evidence || legacy.evidence,
      );
      return {
        status: "failed",
        verified: false,
        idempotency_key: key,
        evidence: verification.evidence,
        review_item_id: reviewId,
      };
    }

    const pdfBytes = fs.readFileSync(tempPath);
    const saved = saveVerifiedResume({
      db: options.db,
      applicationId: options.applicationId,
      pdfBytes,
      metadata: {
        source: "jobright_download",
        suggested_filename: download.suggestedFilename(),
        temp_path: tempPath,
      },
    });

    try {
      fs.unlinkSync(tempPath);
    } catch {
      // temp cleanup is best-effort
    }

    completeIdempotencyKey(options.db, key, saved.path);
    return {
      status: "downloaded",
      path: saved.path,
      sha256: saved.sha256,
      size_bytes: saved.size_bytes,
      verified: true,
      idempotency_key: key,
      evidence: saved.verification.evidence,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Only fail key if we own an in_progress claim
    const existing = getIdempotency(options.db, key);
    let reviewId: string | undefined;
    if (existing?.status === "in_progress") {
      reviewId = markResumeFailure(
        options.db,
        key,
        options.applicationId,
        reason,
      );
    } else {
      const { item } = upsertOpenReviewItem(options.db, {
        applicationId: options.applicationId,
        kind: "MANUAL",
        title: "Resume download failed",
        payload: { reason, idempotency_key: key },
      });
      reviewId = item.id;
    }
    return {
      status: "failed",
      verified: false,
      idempotency_key: key,
      evidence: reason,
      review_item_id: reviewId,
    };
  }
}
