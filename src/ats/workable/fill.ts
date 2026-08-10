import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import type { FormResetResult, UploadVerification } from "../adapter.js";
import { assertFormFillAllowed } from "../../applications/formFillGuards.js";
import {
  detectUploadCommit,
  resolveResumeFileInput,
} from "../shared/uploadResolve.js";
import { workableSelectorsV1 } from "./selectors.js";

/**
 * Workable-bound fill helpers. The field executor itself is the generic
 * one in ../greenhouse/fill.ts (locator by inputId → name → label) — only
 * upload and reset need Workable's own selectors, same split as Lever.
 */

export async function workableUploadFile(
  page: Page,
  kind: "resume",
  filePath: string,
): Promise<UploadVerification> {
  assertFormFillAllowed(`workable.upload.${kind}`);
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
    css: workableSelectorsV1.resume,
  });
  if (!resolution.found) {
    return {
      field: kind,
      path: abs,
      filename,
      size_bytes: stat.size,
      verified: false,
      evidence: `resume file input not found; ${resolution.notes.join("; ")}; inventory: ${JSON.stringify(resolution.inventory)}`,
    };
  }
  const input = resolution.input;
  await input.setInputFiles(abs);
  const commit = await detectUploadCommit(page, input, {
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

export async function workableResetForm(page: Page): Promise<FormResetResult> {
  assertFormFillAllowed("workable.resetForm");
  const form = page.locator(workableSelectorsV1.form).first();
  if ((await form.count()) === 0) {
    return { reset: false, notes: ["application form not found"] };
  }
  await form.evaluate((el: { reset: () => void }) => {
    el.reset();
  });
  return { reset: true, notes: ["HTMLFormElement.reset() invoked"] };
}
