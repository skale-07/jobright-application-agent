import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import type { FormResetResult, UploadVerification } from "../adapter.js";
import { assertFormFillAllowed } from "../../applications/formFillGuards.js";
import {
  detectUploadCommit,
  resolveResumeFileInput,
} from "../shared/uploadResolve.js";
import { workdaySelectorsV1 } from "./selectors.js";

/**
 * Workday-bound fill helpers. Native-input fill reuses the generic
 * executor (../greenhouse/fill.ts); only upload and the resume-autofill
 * kickoff need Workday's own selectors.
 */

export async function workdayUploadFile(
  page: Page,
  kind: "resume",
  filePath: string,
): Promise<UploadVerification> {
  assertFormFillAllowed(`workday.upload.${kind}`);
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    return {
      field: kind,
      path: abs,
      filename: path.basename(abs),
      size_bytes: 0,
      verified: false,
      evidence: "file missing",
    };
  }
  const stat = fs.statSync(abs);
  const filename = path.basename(abs);
  const resolution = await resolveResumeFileInput(page, {
    css: workdaySelectorsV1.wizard.resumeUpload,
  });
  if (!resolution.found) {
    return {
      field: kind,
      path: abs,
      filename,
      size_bytes: stat.size,
      verified: false,
      evidence: `resume file input not found; ${resolution.notes.join("; ")}`,
    };
  }
  await resolution.input.setInputFiles(abs);
  const commit = await detectUploadCommit(page, resolution.input, {
    filename,
    sizeBytes: stat.size,
  });
  return {
    field: kind,
    path: abs,
    filename,
    size_bytes: stat.size,
    verified: commit.verified,
    evidence: `${commit.evidence}; resolved via ${resolution.via}`,
  };
}

export async function workdayResetForm(page: Page): Promise<FormResetResult> {
  assertFormFillAllowed("workday.resetForm");
  // Workday wizards have no single <form> reset — this is a no-op that
  // reports honestly rather than pretending to have cleared state.
  void page;
  return {
    reset: false,
    notes: ["Workday multi-page wizard: no form-level reset available"],
  };
}
