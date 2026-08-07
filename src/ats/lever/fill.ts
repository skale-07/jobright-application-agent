import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import type { FormResetResult, UploadVerification } from "../adapter.js";
import { assertFormFillAllowed } from "../../applications/formFillGuards.js";
import { leverSelectorsV1 } from "./selectors.js";

/**
 * Lever-bound fill helpers. The field executor itself is the generic one in
 * ../greenhouse/fill.ts (locator by inputId → name → label, no greenhouse
 * selectors inside) — only upload and reset need Lever's own selectors.
 * Lever forms have no cover-letter file input; cover letters go in the
 * `comments` textarea, which is essay-routed and never auto-filled.
 */

export async function leverUploadFile(
  page: Page,
  kind: "resume",
  filePath: string,
): Promise<UploadVerification> {
  assertFormFillAllowed(`lever.upload.${kind}`);
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
  const input = page.locator(leverSelectorsV1.resume).first();
  if ((await input.count()) === 0) {
    return {
      field: kind,
      path: abs,
      filename: path.basename(abs),
      size_bytes: stat.size,
      verified: false,
      evidence: "resume file input not found",
    };
  }
  await input.setInputFiles(abs);
  const files = await input.evaluate(
    (el: { files?: ArrayLike<{ name: string; size: number }> | null }) => {
      const list = el.files ? Array.from(el.files) : [];
      return list.map((f) => ({ name: f.name, size: f.size }));
    },
  );
  const filename = path.basename(abs);
  const verified =
    files.some((f) => f.name === filename) ||
    files.some((f) => f.size === stat.size);
  return {
    field: kind,
    path: abs,
    filename,
    size_bytes: stat.size,
    verified,
    evidence: verified
      ? `input files: ${JSON.stringify(files)}`
      : `upload not reflected; input files: ${JSON.stringify(files)}`,
  };
}

export async function leverResetForm(page: Page): Promise<FormResetResult> {
  assertFormFillAllowed("lever.resetForm");
  const form = page.locator(leverSelectorsV1.form).first();
  if ((await form.count()) === 0) {
    return { reset: false, notes: ["application form not found"] };
  }
  await form.evaluate((el: { reset: () => void }) => {
    el.reset();
  });
  return { reset: true, notes: ["HTMLFormElement.reset() invoked"] };
}
