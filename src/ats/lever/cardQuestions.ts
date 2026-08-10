import type { DiscoveredField } from "../adapter.js";

/**
 * Lever custom-question ("cards") labeling — built from a live form
 * snapshot (Field AI, artifacts/ats-fill/lever-live). The live failure:
 * a form with 60 skipped fields whose labels reached the plan as
 * "Type your response" (the placeholder) or a bare cards[uuid][fieldN]
 * name, so the screener bank, the completeness gate's naming, and the
 * prediction queue never saw a single real question.
 *
 * Ground-truth DOM shape (per snapshot):
 *   <li class="application-question custom-question">
 *     <div>
 *       <div class="application-label ..."><div class="text">QUESTION<span class="required">✱</span></div></div>
 *       <div class="application-field ...">
 *         <ul data-qa="multiple-choice">
 *           <li><label><input type="radio" name="cards[uuid][fieldN]" ...>
 *               <span class="application-answer-alternative">OPTION</span></label></li>
 *
 * The question text is NOT the input's <label> — it's a sibling div. This
 * module extracts name → {label, options, required} per card question and
 * the adapter overlays it on the generic discovery output.
 */

export type CardQuestion = {
  label: string;
  required: boolean;
  options: string[];
};

const CARD_NAME_RE = /^cards\[[0-9a-f-]+\]\[field\d+\]$/i;

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Balanced <li> innards starting after the opening tag at `start`. */
function balancedLi(html: string, start: number): string {
  const tokenRe = /<(\/?)li\b[^>]*>/gi;
  tokenRe.lastIndex = start;
  let depth = 1;
  let t: RegExpExecArray | null;
  while ((t = tokenRe.exec(html)) !== null) {
    depth += t[1] === "/" ? -1 : 1;
    if (depth === 0) return html.slice(start, t.index);
    if (t.index - start > 40_000) break;
  }
  return html.slice(start, Math.min(html.length, start + 40_000));
}

/** name → question metadata for every custom-question card field. */
export function discoverLeverCardQuestions(html: string): Map<string, CardQuestion> {
  const out = new Map<string, CardQuestion>();
  const liOpenRe = /<li\b[^>]*class="[^"]*custom-question[^"]*"[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = liOpenRe.exec(html)) !== null) {
    const block = balancedLi(html, m.index + m[0].length);

    const labelMatch =
      /class="[^"]*application-label[^"]*"[\s\S]{0,200}?<div[^>]*class="[^"]*\btext\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(
        block,
      );
    const rawLabel = labelMatch ? stripTags(labelMatch[1] ?? "") : "";
    const label = rawLabel.replace(/[✱*]\s*$/, "").trim();
    if (!label) continue;
    const required =
      /class="[^"]*\brequired\b[^"]*"/i.test(block) || /\brequired\b/i.test(block);

    // Options: the alternative spans, in order, deduped.
    const options: string[] = [];
    const optRe =
      /<span[^>]*class="[^"]*application-answer-alternative[^"]*"[^>]*>([\s\S]*?)<\/span>/gi;
    let om: RegExpExecArray | null;
    while ((om = optRe.exec(block)) !== null && options.length < 24) {
      const t = stripTags(om[1] ?? "");
      if (t && !options.includes(t)) options.push(t);
    }

    // Field names inside this question block.
    const nameRe = /name="(cards\[[0-9a-f-]+\]\[field\d+\])"/gi;
    let nm: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((nm = nameRe.exec(block)) !== null) {
      const name = nm[1]!;
      if (seen.has(name)) continue;
      seen.add(name);
      out.set(name, { label, required, options });
    }
  }
  return out;
}

/**
 * Overlay card-question metadata on generic discovery output: real
 * question labels replace placeholder/name labels, choice fields gain
 * their option texts, and required flags propagate. Non-card fields pass
 * through untouched.
 */
export function applyLeverCardQuestions(
  fields: DiscoveredField[],
  html: string,
): DiscoveredField[] {
  const cards = discoverLeverCardQuestions(html);
  if (cards.size === 0) return fields;
  return fields.map((f) => {
    const name = f.name ?? f.id;
    if (!name || !CARD_NAME_RE.test(name)) return f;
    const q = cards.get(name);
    if (!q) return f;
    const next: DiscoveredField = {
      ...f,
      label: q.label,
      required: f.required || q.required,
    };
    if ((f.type === "radio" || f.type === "checkbox" || f.type === "select") && q.options.length > 0) {
      next.options = q.options;
    }
    return next;
  });
}
