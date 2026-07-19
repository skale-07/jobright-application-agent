import type { Page, Locator } from "playwright";
import fs from "node:fs";
import path from "node:path";
import type {
  FillResult,
  FormResetResult,
  FormVerificationResult,
  ResolvedApplicationAnswers,
  UploadVerification,
} from "../adapter.js";
import { greenhouseSelectorsV1 } from "./selectors.js";
import type { FillPlanEntry } from "../../applications/resolveAnswers.js";
import {
  assertExecutableApprovedEntry,
  type ApprovedFillPlanEntry,
} from "../../applications/approvedFillPlan.js";
import { isDemographicsField } from "../../applications/essayDetector.js";
import {
  assertFormFillAllowed,
  assertSubmitAllowed,
} from "../../applications/formFillGuards.js";

export type FieldMeta = {
  name?: string;
  inputId?: string;
  type: FillPlanEntry["type"];
};

export type ExecutableFillEntry = ApprovedFillPlanEntry | FillPlanEntry;

function cssEscapeIdent(id: string): string {
  return id.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
}

export function locatorForField(
  page: Page,
  entry: Pick<FillPlanEntry, "field_id" | "label"> & {
    name?: string;
    inputId?: string;
  },
): Locator {
  if (entry.inputId) {
    return page.locator(`#${cssEscapeIdent(entry.inputId)}`);
  }
  if (entry.name) {
    return page.locator(`[name="${entry.name.replace(/"/g, '\\"')}"]`).first();
  }
  return page.getByLabel(entry.label, { exact: false }).first();
}

async function setSelectByValueOrLabel(
  locator: Locator,
  value: unknown,
): Promise<void> {
  const text = String(value);
  try {
    await locator.selectOption({ label: text });
    return;
  } catch {
    // fall through
  }
  try {
    await locator.selectOption({ value: text.toLowerCase() });
    return;
  } catch {
    // fall through
  }
  const options = await locator.locator("option").allTextContents();
  const match = options.find(
    (o) => o.trim().toLowerCase() === text.toLowerCase(),
  );
  if (match) {
    await locator.selectOption({ label: match });
    return;
  }
  const partial = options.find((o) =>
    o.toLowerCase().includes(text.toLowerCase()),
  );
  if (partial) {
    await locator.selectOption({ label: partial });
    return;
  }
  throw new Error(
    `No select option matching "${text}" (options: ${options.join(", ")})`,
  );
}

function valuesMatch(expected: unknown, observed: unknown): boolean {
  if (expected === observed) return true;
  const e = String(expected).trim().toLowerCase();
  const o = String(observed).trim().toLowerCase();
  if (e === o) return true;
  if (e === "yes" && ["yes", "y", "true", "1"].includes(o)) return true;
  if (e === "no" && ["no", "n", "false", "0"].includes(o)) return true;
  return false;
}

function isApprovedExecutable(
  entry: ExecutableFillEntry,
): entry is ApprovedFillPlanEntry & { approved: true; action: "FILL" } {
  return (
    "approved" in entry &&
    entry.approved === true &&
    entry.action === "FILL"
  );
}

/**
 * Fill Greenhouse fields from an approved fill plan.
 * Rejects essay/textarea/demographic/unapproved entries even if present.
 * Call assertFormFillAllowed first. Does not click submit.
 */
export async function greenhouseFillFromPlan(
  page: Page,
  entries: ExecutableFillEntry[],
  fieldMeta: Map<string, FieldMeta>,
): Promise<FillResult> {
  assertFormFillAllowed("greenhouse.fill");
  const filled: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  for (const entry of entries) {
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
      if (entry.type === "textarea") {
        throw new Error("textarea/essay never filled");
      }
      if (
        isDemographicsField({
          id: entry.field_id,
          label: entry.label,
          type: entry.type,
          required: false,
        })
      ) {
        throw new Error("demographics never filled");
      }
    } catch (err) {
      errors.push(
        `${entry.field_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    const meta = fieldMeta.get(entry.field_id);
    try {
      const loc = locatorForField(page, {
        field_id: entry.field_id,
        label: entry.label,
        ...(meta?.name ? { name: meta.name } : {}),
        ...(meta?.inputId ? { inputId: meta.inputId } : {}),
      });
      const type = meta?.type ?? entry.type;
      if (type === "select") {
        await setSelectByValueOrLabel(loc, entry.value);
      } else if (type === "checkbox") {
        const on = Boolean(entry.value) && entry.value !== "No";
        if (on) await loc.check();
        else await loc.uncheck();
      } else if (type === "radio") {
        const name = meta?.name;
        const group = name
          ? page.locator(`[name="${name.replace(/"/g, '\\"')}"]`)
          : page.locator('input[type="radio"]');
        const wanted = String(entry.value).toLowerCase();
        const count = await group.count();
        let matched = false;
        for (let i = 0; i < count; i++) {
          const opt = group.nth(i);
          const val = ((await opt.getAttribute("value")) ?? "").toLowerCase();
          const labelText = await opt.evaluate(
            (el: {
              getAttribute: (name: string) => string | null;
              parentElement?: { textContent?: string | null } | null;
            }) => {
              const id = el.getAttribute("id");
              if (id) {
                // document is available in the browser runtime only
                const doc = (
                  globalThis as unknown as {
                    document?: {
                      querySelector: (s: string) => { textContent?: string | null } | null;
                    };
                  }
                ).document;
                const lab = doc?.querySelector(`label[for="${id}"]`);
                if (lab?.textContent) return lab.textContent.trim();
              }
              return el.parentElement?.textContent?.trim() ?? "";
            },
          );
          if (val === wanted || labelText.toLowerCase().includes(wanted)) {
            await opt.check();
            matched = true;
            break;
          }
        }
        if (!matched) {
          throw new Error(`No radio option for "${entry.value}"`);
        }
      } else {
        await loc.fill(String(entry.value));
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

export async function greenhouseReadFieldValue(
  page: Page,
  entry: FillPlanEntry & { name?: string; inputId?: string },
): Promise<unknown> {
  const loc = locatorForField(page, entry);
  const tag = await loc.evaluate((el: { tagName: string }) =>
    el.tagName.toLowerCase(),
  );
  if (tag === "select") {
    const value = await loc.inputValue();
    const label = await loc.evaluate(
      (el: {
        selectedOptions?: ArrayLike<{ textContent?: string | null }>;
      }) => {
        const opt = el.selectedOptions?.[0];
        return opt?.textContent?.trim() ?? "";
      },
    );
    return { value, label };
  }
  const type = await loc.getAttribute("type");
  if (type === "checkbox" || type === "radio") {
    return loc.isChecked();
  }
  return loc.inputValue();
}

export async function greenhouseVerifyFromPlan(
  page: Page,
  entries: ExecutableFillEntry[],
  fieldMeta: Map<string, FieldMeta>,
): Promise<FormVerificationResult> {
  const fields: FormVerificationResult["fields"] = [];
  const warnings: string[] = [];

  const fillable = entries.filter(
    (e) =>
      (e.action === "fill" || e.action === "FILL") &&
      (!("approved" in e) || e.approved === true),
  );

  for (const entry of fillable) {
    const meta = fieldMeta.get(entry.field_id);
    const canonical = entry.canonical_field ?? entry.field_id;
    try {
      const observed = await greenhouseReadFieldValue(page, {
        field_id: entry.field_id,
        label: entry.label,
        type: entry.type,
        canonical_field: entry.canonical_field,
        action: "fill",
        value: entry.value,
        reason: "verify",
        ...(meta?.name ? { name: meta.name } : {}),
        ...(meta?.inputId ? { inputId: meta.inputId } : {}),
      });
      const expected = entry.value;
      let match = false;
      if (
        observed &&
        typeof observed === "object" &&
        "value" in observed &&
        "label" in observed
      ) {
        const o = observed as { value: unknown; label: unknown };
        match =
          valuesMatch(expected, o.value) || valuesMatch(expected, o.label);
      } else {
        match = valuesMatch(expected, observed);
      }
      fields.push({
        canonical_field: canonical,
        expected,
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
    uploads: [],
    warnings,
  };
}

export async function greenhouseUploadFile(
  page: Page,
  kind: "resume" | "cover_letter",
  filePath: string,
): Promise<UploadVerification> {
  assertFormFillAllowed(`greenhouse.upload.${kind}`);
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
  const selector =
    kind === "resume"
      ? greenhouseSelectorsV1.resume
      : greenhouseSelectorsV1.coverLetter;
  const input = page.locator(selector).first();
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

export async function greenhouseResetForm(page: Page): Promise<FormResetResult> {
  assertFormFillAllowed("greenhouse.resetForm");
  const form = page.locator(greenhouseSelectorsV1.form).first();
  if ((await form.count()) === 0) {
    return { reset: false, notes: ["application form not found"] };
  }
  await form.evaluate((el: { reset: () => void }) => {
    el.reset();
  });
  return { reset: true, notes: ["HTMLFormElement.reset() invoked"] };
}

export async function greenhouseRefuseSubmit(page: Page): Promise<never> {
  void page;
  assertSubmitAllowed("greenhouse.submit");
  throw new Error(
    "Greenhouse submit is not implemented in Phase 5 — use Phase 7 submission path",
  );
}

export async function greenhouseVerifyAnswers(
  page: Page,
  expected: ResolvedApplicationAnswers,
  entries: ExecutableFillEntry[],
  fieldMeta: Map<string, FieldMeta>,
): Promise<FormVerificationResult> {
  const filtered = entries.filter(
    (e) =>
      (e.action === "fill" || e.action === "FILL") &&
      (!("approved" in e) || e.approved === true) &&
      e.canonical_field &&
      expected[e.canonical_field] !== undefined,
  );
  return greenhouseVerifyFromPlan(page, filtered, fieldMeta);
}
