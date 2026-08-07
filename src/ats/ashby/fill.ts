import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "playwright";
import type {
  FillResult,
  FormResetResult,
  FormVerificationResult,
  UploadVerification,
} from "../adapter.js";
import { assertFormFillAllowed } from "../../applications/formFillGuards.js";
import {
  assertExecutableApprovedEntry,
  type ApprovedFillPlanEntry,
} from "../../applications/approvedFillPlan.js";
import {
  greenhouseFillFromPlan,
  greenhouseVerifyFromPlan,
  type ExecutableFillEntry,
  type FieldMeta,
} from "../greenhouse/fill.js";
import { pickOptionLabel } from "../greenhouse/comboboxFill.js";
import {
  fillButtonGroup,
  readButtonGroupValue,
} from "./buttonGroupFill.js";
import { ashbySelectorsV1 } from "./selectors.js";

/**
 * Ashby fill executor. Radio-typed entries are Ashby button groups
 * (role=radiogroup + <button> children — the generic executor's radio
 * branch expects input[type=radio] and cannot handle them); everything
 * else delegates to the generic executor in ../greenhouse/fill.ts, whose
 * combobox path already commits and reads back correctly against Ashby's
 * role-based portal listbox DOM. The full guard chain
 * (assertFormFillAllowed → assertExecutableApprovedEntry, which rejects
 * textarea/demographics/unapproved) runs on the button-group path here and
 * inside the generic executor for the rest.
 */

function isApprovedExecutable(
  entry: ExecutableFillEntry,
): entry is ApprovedFillPlanEntry & { approved: true; action: "FILL" } {
  return (
    "approved" in entry && entry.approved === true && entry.action === "FILL"
  );
}

function buttonGroupLocator(page: Page, fieldId: string): Locator {
  return page
    .locator(
      `${ashbySelectorsV1.buttonGroup.container}[data-field-id="${fieldId.replace(/"/g, '\\"')}"]`,
    )
    .first();
}

function isRadioEntry(
  entry: ExecutableFillEntry,
  fieldMeta: Map<string, FieldMeta>,
): boolean {
  return (fieldMeta.get(entry.field_id)?.type ?? entry.type) === "radio";
}

export async function ashbyFillFromPlan(
  page: Page,
  entries: ExecutableFillEntry[],
  fieldMeta: Map<string, FieldMeta>,
): Promise<FillResult> {
  assertFormFillAllowed("ashby.fill");

  const groupEntries = entries.filter((e) => isRadioEntry(e, fieldMeta));
  const otherEntries = entries.filter((e) => !isRadioEntry(e, fieldMeta));

  const base = await greenhouseFillFromPlan(page, otherEntries, fieldMeta);
  const filled = [...base.filled];
  const skipped = [...base.skipped];
  const errors = [...base.errors];

  for (const entry of groupEntries) {
    if (!isApprovedExecutable(entry)) {
      if (
        entry.action === "fill" ||
        entry.action === "FILL" ||
        ("approved" in entry && entry.approved)
      ) {
        errors.push(
          `${entry.field_id}: rejected — entry is not an approved FILL action`,
        );
      } else {
        skipped.push(entry.field_id);
      }
      continue;
    }
    try {
      assertExecutableApprovedEntry(entry);
    } catch (err) {
      errors.push(
        `${entry.field_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    try {
      const group = buttonGroupLocator(page, entry.field_id);
      if ((await group.count()) === 0) {
        throw new Error("button group not found by data-field-id");
      }
      const result = await fillButtonGroup(group, entry.value);
      if (!result.committed) {
        throw new Error(
          `button group option not committed: ${result.notes.join("; ")}`,
        );
      }
      filled.push(entry.canonical_field ?? entry.field_id);
    } catch (err) {
      errors.push(
        `${entry.field_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { filled, skipped, errors };
}

export async function ashbyVerifyFromPlan(
  page: Page,
  entries: ExecutableFillEntry[],
  fieldMeta: Map<string, FieldMeta>,
): Promise<FormVerificationResult> {
  const groupEntries = entries.filter((e) => isRadioEntry(e, fieldMeta));
  const otherEntries = entries.filter((e) => !isRadioEntry(e, fieldMeta));

  const base = await greenhouseVerifyFromPlan(page, otherEntries, fieldMeta);
  const fields = [...base.fields];
  const warnings = [...base.warnings];

  const fillable = groupEntries.filter(
    (e) =>
      (e.action === "fill" || e.action === "FILL") &&
      (!("approved" in e) || e.approved === true),
  );
  for (const entry of fillable) {
    const canonical = entry.canonical_field ?? entry.field_id;
    try {
      const group = buttonGroupLocator(page, entry.field_id);
      const observed = await readButtonGroupValue(group);
      // pickOptionLabel gives Yes/No synonym + case-insensitive equivalence.
      const match =
        observed !== null &&
        pickOptionLabel([observed], String(entry.value)).ok;
      fields.push({
        canonical_field: canonical,
        expected: entry.value,
        observed,
        match,
      });
    } catch (err) {
      warnings.push(
        `verify ${canonical}: ${err instanceof Error ? err.message : String(err)}`,
      );
      fields.push({
        canonical_field: canonical,
        expected: entry.value,
        observed: null,
        match: false,
      });
    }
  }

  return {
    passed:
      fields.length > 0 && fields.every((f) => f.match) && warnings.length === 0,
    fields,
    uploads: base.uploads,
    warnings,
  };
}

export async function ashbyUploadFile(
  page: Page,
  kind: "resume",
  filePath: string,
): Promise<UploadVerification> {
  assertFormFillAllowed(`ashby.upload.${kind}`);
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
  const input = page.locator(ashbySelectorsV1.resume).first();
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
  // setInputFiles works on CSS-hidden (display:none) inputs behind
  // Ashby's drag-drop zone — visibility is not required.
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

/**
 * Honest failure: Ashby's controlled React inputs do not respond to
 * HTMLFormElement.reset(). The fixture's uncontrolled inputs would make a
 * reset() look green here while lying about live behavior, so this reports
 * reset:false unconditionally — a page reload is the only reliable reset.
 */
export async function ashbyResetForm(page: Page): Promise<FormResetResult> {
  assertFormFillAllowed("ashby.resetForm");
  void page;
  return {
    reset: false,
    notes: [
      "Ashby SPA: controlled inputs do not respond to form.reset(); reload the page to reset",
    ],
  };
}
