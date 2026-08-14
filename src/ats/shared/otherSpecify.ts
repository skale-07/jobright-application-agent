import type { Page } from "playwright";
import { discoverFieldsFromHtml } from "../../applications/fieldDiscovery.js";
import type { DiscoveredField } from "../adapter.js";

/**
 * The second half of the "Other" contract (operator directive 2026-08-14):
 *
 *   "if the predicted option the LLM gives, other should be clicked and if
 *    other provides another field space then its a free-text class."
 *
 * A closed dropdown that offers "Other" almost always reveals a companion
 * text box once "Other" is chosen — "Other (please specify)". That revealed
 * box is an OPEN answer space: anything typeable is valid, so the real
 * answer the dropdown could not hold goes straight in.
 *
 * This runs AFTER the adapter's fill, because the box does not exist in the
 * DOM until the option is committed. It compares the post-fill field set
 * against the pre-fill one: a control that was not there before, is a text
 * control, and sits next to the field we answered "Other" is the specify
 * box. Nothing else is touched.
 *
 * Conservative by construction:
 *   - Only fields that appeared AFTER the fill are eligible. An existing
 *     empty text field is never co-opted.
 *   - Only text/textarea controls — a newly revealed dropdown is a fresh
 *     closed question and parks for the normal tiers, never guessed at.
 *   - Only when we actually hold an intended answer. No answer ⇒ the box is
 *     reported unfilled so it surfaces as a normal Answer-needed item.
 */

export type OtherSpecifyRequest = {
  field_id: string;
  label: string;
  /** The answer the closed list could not represent. */
  intended: string | null;
};

export type OtherSpecifyOutcome = {
  field_id: string;
  label: string;
  /** id of the revealed box, when one appeared. */
  revealed_field_id: string | null;
  filled: boolean;
  note: string;
};

/** Does this revealed control accept arbitrary text (an OPEN answer space)? */
function isOpenTextControl(f: DiscoveredField): boolean {
  if ((f.options?.length ?? 0) > 0) return false;
  return f.type === "text" || f.type === "textarea";
}

/**
 * The revealed box usually carries the parent question's wording ("Other
 * organization", "If other, please specify") or simply follows it in DOM
 * order. Score both; require a positive signal rather than picking the
 * first new field on the page.
 */
export function pickSpecifyField(
  newFields: DiscoveredField[],
  parentLabel: string,
): DiscoveredField | null {
  const open = newFields.filter(isOpenTextControl);
  if (open.length === 0) return null;

  const explicit = open.find((f) =>
    /\b(other|specify|please describe|if other|self.describe)\b/i.test(f.label),
  );
  if (explicit) return explicit;

  // Shared wording with the question it belongs to ("University organizations"
  // → "University organizations (other)").
  const parentTokens = parentLabel
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4);
  if (parentTokens.length > 0) {
    const related = open.find((f) => {
      const l = f.label.toLowerCase();
      return parentTokens.filter((t) => l.includes(t)).length >= 2;
    });
    if (related) return related;
  }

  // Exactly one new open box appeared right after we chose "Other" — the
  // causal link is strong enough on its own. Two or more is ambiguous and
  // parks rather than guessing which one belongs to which question.
  return open.length === 1 ? open[0]! : null;
}

/**
 * Fill the text boxes that choosing "Other" revealed. Returns one outcome
 * per request so the artifact records what the employer actually received.
 * Fail-open: any error becomes a note and leaves the box empty for review.
 */
export async function fillOtherSpecify(input: {
  page: Page;
  requests: OtherSpecifyRequest[];
  /** Field ids present BEFORE the fill ran. */
  knownFieldIds: Set<string>;
}): Promise<OtherSpecifyOutcome[]> {
  const { page, requests, knownFieldIds } = input;
  if (requests.length === 0) return [];

  let html: string;
  try {
    html = await page.content();
  } catch {
    return requests.map((r) => ({
      field_id: r.field_id,
      label: r.label,
      revealed_field_id: null,
      filled: false,
      note: "could not re-read the page after fill",
    }));
  }
  const newFields = discoverFieldsFromHtml(html).filter(
    (f) => !knownFieldIds.has(f.id),
  );

  const outcomes: OtherSpecifyOutcome[] = [];
  const claimed = new Set<string>();
  for (const req of requests) {
    const available = newFields.filter((f) => !claimed.has(f.id));
    const box = pickSpecifyField(available, req.label);
    if (!box) {
      outcomes.push({
        field_id: req.field_id,
        label: req.label,
        revealed_field_id: null,
        filled: false,
        note: `chose "Other" and no text box appeared — nothing further to answer`,
      });
      continue;
    }
    claimed.add(box.id);
    if (!req.intended) {
      outcomes.push({
        field_id: req.field_id,
        label: req.label,
        revealed_field_id: box.id,
        filled: false,
        note: `"Other" revealed "${box.label.slice(0, 60)}" but no answer is on file — left for review`,
      });
      continue;
    }
    try {
      const selector = box.inputId
        ? `[id="${box.inputId.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`
        : box.name
          ? `[name="${box.name.replace(/"/g, '\\"')}"]`
          : null;
      if (!selector) {
        outcomes.push({
          field_id: req.field_id,
          label: req.label,
          revealed_field_id: box.id,
          filled: false,
          note: `"Other" revealed a box with no addressable id/name — left for review`,
        });
        continue;
      }
      const loc = page.locator(selector).first();
      await loc.fill(req.intended, { timeout: 5_000 });
      const readBack = await loc.inputValue({ timeout: 2_000 }).catch(() => "");
      const filled = readBack.trim() === req.intended.trim();
      outcomes.push({
        field_id: req.field_id,
        label: req.label,
        revealed_field_id: box.id,
        filled,
        note: filled
          ? `"Other" revealed "${box.label.slice(0, 60)}" — answered with the real value`
          : `"Other" specify box did not accept the value (read back "${readBack.slice(0, 40)}")`,
      });
    } catch (err) {
      outcomes.push({
        field_id: req.field_id,
        label: req.label,
        revealed_field_id: box.id,
        filled: false,
        note: `"Other" specify box could not be filled: ${err instanceof Error ? err.message.slice(0, 80) : String(err)}`,
      });
    }
  }
  return outcomes;
}
