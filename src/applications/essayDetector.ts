import type { DiscoveredField } from "../ats/adapter.js";
import { getConfig } from "../config/index.js";
import { normalizeFieldLabel } from "./fieldNormalization.js";

export type EssayClassification = {
  field_id: string;
  label: string;
  is_essay: boolean;
  reasons: string[];
  estimated_min_words: number | null;
};

const ESSAY_LABEL_HINTS =
  /why (do )?you (want|are)|cover letter|tell us about|describe|essay|statement of|motivation|what interests you|additional information|anything else/i;

/**
 * Hard-stop gate for inspection → ESSAY_REQUIRED. Off by default (see
 * ESSAY_REQUIRED_GATE_ENABLED): heuristics false-positive too often on
 * voluntary demographic combobox labels.
 */
export function isEssayRequiredGateEnabled(): boolean {
  return getConfig().essayRequiredGateEnabled;
}

/**
 * Heuristic essay detector. Used for proposed-plan SKIP and optional
 * hard-stop when {@link isEssayRequiredGateEnabled} (default off).
 * Flags long textareas / high minlength / essay-ish labels.
 */
export function classifyEssayFields(fields: DiscoveredField[]): EssayClassification[] {
  return fields.map((f) => {
    const reasons: string[] = [];
    let isEssay = false;
    let estimatedMin: number | null = null;

    // File uploads (resume/cover) are not free-text essays
    if (f.type === "file") {
      return {
        field_id: f.id,
        label: f.label,
        is_essay: false,
        reasons: [],
        estimated_min_words: null,
      };
    }

    // EEO / self-ID selects often say "How would you describe your gender…".
    // That must not hit the "describe" essay hint before demographics handling.
    if (isDemographicsField(f)) {
      return {
        field_id: f.id,
        label: f.label,
        is_essay: false,
        reasons: [],
        estimated_min_words: null,
      };
    }

    if (f.type === "textarea") {
      reasons.push("textarea");
      isEssay = true;
    }
    if (f.maxLength && f.maxLength >= 500) {
      reasons.push(`maxLength>=500 (${f.maxLength})`);
      isEssay = true;
    }
    if (f.minLength && f.minLength >= 100) {
      reasons.push(`minLength>=100 (${f.minLength})`);
      estimatedMin = Math.ceil(f.minLength / 5);
      isEssay = true;
    }
    if (ESSAY_LABEL_HINTS.test(f.label)) {
      reasons.push("essay-like label");
      isEssay = true;
    }
    // A one-line <input> is a screener, even if the label says "describe".
    // "Describe your debugging spirit animal in one word" is not a cover letter.
    if (f.type === "text" && !f.minLength && (!f.maxLength || f.maxLength < 200)) {
      isEssay = false;
      reasons.length = 0;
    }
    // Select/radio/checkbox are never essays
    if (f.type === "select" || f.type === "radio" || f.type === "checkbox" || f.type === "date") {
      isEssay = false;
      reasons.length = 0;
    }

    if (isEssay && estimatedMin === null) {
      estimatedMin = 50;
    }

    return {
      field_id: f.id,
      label: f.label,
      is_essay: isEssay,
      reasons,
      estimated_min_words: isEssay ? estimatedMin : null,
    };
  });
}

export function essayFieldsOnly(fields: DiscoveredField[]): EssayClassification[] {
  return classifyEssayFields(fields).filter((c) => c.is_essay);
}

export function isDemographicsField(field: DiscoveredField): boolean {
  const n = normalizeFieldLabel(
    `${field.label} ${field.name ?? ""} ${field.inputId ?? ""}`,
  );
  return /gender|race|ethnicity|veteran|disability|hispanic|latino|transgender|eeo|equal opportunity|decline to (self-)?identify|sexual orientation|pronoun/.test(
    n,
  );
}
