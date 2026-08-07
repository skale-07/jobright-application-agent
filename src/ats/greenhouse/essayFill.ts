import type { Page } from "playwright";
import type { Db } from "../../storage/db/client.js";
import type { FillResult } from "../adapter.js";
import { assertFormFillAllowed } from "../../applications/formFillGuards.js";
import {
  assertExecutableHumanEssayEntry,
  type HumanEssayEntry,
} from "../../applications/essayFill.js";
import { locatorForField, type FieldMeta } from "./fill.js";

/**
 * Fill Greenhouse essay textareas from human-authored answers only.
 * Every entry passes assertExecutableHumanEssayEntry, which re-reads the
 * backing application_answers row (source='human') at execution time.
 * This module never touches non-textarea fields and never submits.
 */
export async function greenhouseFillEssays(
  page: Page,
  entries: HumanEssayEntry[],
  fieldMeta: Map<string, FieldMeta>,
  db: Db,
): Promise<FillResult> {
  assertFormFillAllowed("greenhouse.essayFill");
  const filled: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  for (const entry of entries) {
    try {
      assertExecutableHumanEssayEntry(db, entry);
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
      const tag = await loc.evaluate((el: { tagName: string }) =>
        el.tagName.toLowerCase(),
      );
      if (tag !== "textarea") {
        throw new Error(`resolved element is <${tag}>, expected <textarea>`);
      }
      await loc.fill(entry.value);
      const readBack = await loc.inputValue();
      if (readBack !== entry.value) {
        throw new Error("read-back mismatch after essay fill");
      }
      filled.push(entry.field_id);
    } catch (err) {
      errors.push(
        `${entry.field_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { filled, skipped, errors };
}
