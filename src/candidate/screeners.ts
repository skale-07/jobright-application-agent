/**
 * The screener-question registry: the long tail of "Additional Questions"
 * that job applications ask beyond the twelve profile fields — availability,
 * education level, closest location, how-did-you-hear, referral, links.
 *
 * Accuracy model (why this is trustworthy):
 *   1. ANSWERS COME ONLY FROM THE OPERATOR'S BANK (screeners.json on
 *      disk). No model ever generates an answer — intelligence is applied
 *      only to MAPPING a page label to a bank key, and even that mapping
 *      must survive deterministic validation.
 *   2. For choice controls the bank answer must literally match one of the
 *      page's options (exact → case-insensitive → registry synonym).
 *      No match ⇒ the field parks for review; nothing is guessed.
 *   3. Per-key policy: sensitive keys (salary, notice period) are
 *      review-only; optional-referral is skip-when-empty; demographics
 *      never route here at all (filtered upstream).
 *   4. Everything filled is re-read from the page by the existing verify
 *      layer — a wrong screener answer fails verification like any other
 *      field and blocks the submit.
 */

export type ScreenerKind = "yes_no" | "option" | "short_text" | "url";

export type ScreenerPolicy =
  | "auto_fill" // safe factual/preference value from the bank
  | "review_required" // always a human decision (e.g. salary)
  | "skip_if_empty"; // fill when the bank has it, silently skip otherwise

export type ScreenerDef = {
  key: string;
  /** Human description — also the ONLY thing the LLM mapper ever sees. */
  description: string;
  kind: ScreenerKind;
  policy: ScreenerPolicy;
  /** Tested against the normalized label (lowercase, collapsed spaces). */
  patterns: RegExp[];
  /** Option synonyms: bank answer → acceptable page-option spellings. */
  synonyms?: Record<string, string[]>;
};

/** Yes/No spellings seen across ATSes. */
const YES = ["yes", "y", "true"];
const NO = ["no", "n", "false"];

/**
 * The curated set, from real forms (the Cohere/Ashby intern application is
 * the reference specimen). Order matters: first pattern match wins, so
 * more specific keys sit above generic ones.
 */
export const SCREENER_REGISTRY: ScreenerDef[] = [
  {
    key: "availability_full_time",
    description:
      "Whether the candidate is available for a full-time internship/role for the stated period",
    kind: "yes_no",
    policy: "auto_fill",
    patterns: [
      /available .*full[- ]?time/,
      /full[- ]?time (internship|position|role|co-?op)/,
      /able to work full[- ]?time/,
    ],
    synonyms: { Yes: YES, No: NO },
  },
  {
    key: "education_level",
    description:
      "Current level of education being pursued (Undergrad / Master's / PhD / Bootcamp)",
    kind: "option",
    policy: "auto_fill",
    patterns: [
      /level of education/,
      /current(ly)? (level|degree)/,
      /degree (level|type|you are pursuing)/,
      /education you are pursuing/,
    ],
    synonyms: {
      Undergrad: ["undergrad", "undergraduate", "bachelor", "bachelors", "bachelor's", "bs", "ba"],
      "Master's/MBA": ["master", "masters", "master's", "mba", "ms", "meng", "master's/mba"],
      PhD: ["phd", "doctorate", "doctoral"],
      "Post-Grad Diploma/Bootcamp Program": ["bootcamp", "diploma", "post-grad", "postgrad"],
    },
  },
  {
    key: "closest_location",
    description:
      "Which of the company's listed locations/regions the candidate is closest to or prefers",
    kind: "option",
    policy: "auto_fill",
    patterns: [
      /which location are you (the )?closest to/,
      /closest (office|location|hub)/,
      /preferred (office|location|hub)/,
      /which (office|region) /,
    ],
  },
  {
    key: "how_heard",
    description: "How the candidate heard about this role/company",
    kind: "short_text",
    policy: "auto_fill",
    patterns: [
      /how did you (hear|learn|find out) about/,
      /where did you (hear|find|see) /,
      /source of (this )?application/,
    ],
  },
  {
    key: "referral_name",
    description:
      "Name of the employee who referred the candidate (usually optional)",
    kind: "short_text",
    policy: "skip_if_empty",
    patterns: [
      /referred by .*(employee|someone)/,
      /who referred you/,
      /referr?al('s)? name/,
      /if you were referred/,
    ],
  },
  {
    key: "willing_to_relocate",
    description: "Willingness to relocate for the role",
    kind: "yes_no",
    policy: "auto_fill",
    patterns: [/willing to relocate/, /open to relocat/, /able to relocate/],
    synonyms: { Yes: YES, No: NO },
  },
  {
    key: "remote_or_onsite",
    description: "Preference between remote, hybrid, and on-site work",
    kind: "option",
    policy: "auto_fill",
    patterns: [
      /remote.*(hybrid|on-?site|in[- ]office)/,
      /work (arrangement|preference|setup)/,
      /prefer to work/,
    ],
    synonyms: {
      Remote: ["remote", "fully remote"],
      Hybrid: ["hybrid"],
      "On-site": ["on-site", "onsite", "in office", "in-office"],
    },
  },
  {
    key: "start_availability",
    description: "Earliest start date / availability to begin",
    kind: "short_text",
    policy: "auto_fill",
    patterns: [
      /(earliest|available) start date/,
      /when (can|could|are) you (start|available)/,
      /date .*available to (start|begin)/,
    ],
  },
  {
    key: "internship_term",
    description:
      "Which internship term/season is being applied for (e.g. Winter 2027, Summer 2026)",
    kind: "option",
    policy: "auto_fill",
    patterns: [
      /which (term|season|semester|co-?op term)/,
      /internship (term|session|cycle)/,
      /(summer|winter|fall|spring) .*term/,
    ],
  },
  {
    key: "hours_per_week",
    description: "Hours per week the candidate can commit",
    kind: "short_text",
    policy: "auto_fill",
    patterns: [/hours per week/, /weekly (hours|availability)/],
  },
  {
    key: "previously_applied_or_worked",
    description:
      "Whether the candidate has previously applied to, worked at, or interned at this company",
    kind: "yes_no",
    policy: "auto_fill",
    patterns: [
      /previously (applied|worked|interned|employed)/,
      /ever (applied|worked|been employed) (at|to|with|for)/,
      /former (employee|intern)/,
      /current or former employee/,
    ],
    synonyms: { Yes: YES, No: NO },
  },
  {
    key: "age_over_18",
    description: "Whether the candidate is at least 18 years old",
    kind: "yes_no",
    policy: "auto_fill",
    patterns: [/(at least|over) (18|eighteen)/, /18 years (of age|or older)/],
    synonyms: { Yes: YES, No: NO },
  },
  {
    key: "non_compete",
    description:
      "Whether the candidate is bound by a non-compete or similar restriction",
    kind: "yes_no",
    policy: "auto_fill",
    patterns: [/non-?compete/, /restrictive covenant/],
    synonyms: { Yes: YES, No: NO },
  },
  {
    key: "government_employment",
    description:
      "Whether the candidate is or was a government official/employee (compliance question)",
    kind: "yes_no",
    policy: "auto_fill",
    patterns: [/government (official|employee|employment)/],
    synonyms: { Yes: YES, No: NO },
  },
  {
    key: "security_clearance",
    description: "Whether the candidate holds a security clearance",
    kind: "yes_no",
    policy: "auto_fill",
    patterns: [/security clearance/],
    synonyms: { Yes: YES, No: NO },
  },
  {
    key: "twitter_url",
    description: "Twitter/X profile URL",
    kind: "url",
    policy: "skip_if_empty",
    patterns: [/twitter/, /\bx (profile|url|handle)/],
  },
  {
    key: "portfolio_url",
    description: "Portfolio / other website URL (when not the profile's website field)",
    kind: "url",
    policy: "skip_if_empty",
    patterns: [/portfolio/, /other website/, /personal site/],
  },
  // ── review-only keys: matched so the review item is SPECIFIC, never filled ──
  {
    key: "salary_expectations",
    description: "Expected salary / compensation expectations",
    kind: "short_text",
    policy: "review_required",
    patterns: [
      /salary (expectation|requirement)/,
      /expected (salary|compensation|pay)/,
      /desired (salary|compensation|pay|rate)/,
      /compensation expectation/,
      /hourly rate/,
    ],
  },
  {
    key: "notice_period",
    description: "Notice period with current employer",
    kind: "short_text",
    policy: "review_required",
    patterns: [/notice period/],
  },
];

/**
 * A promoted custom entry: a question the registry doesn't model, whose
 * answer the operator approved once via the prediction review flow. It
 * matches future forms by EXACT normalized label (no regex authoring) and
 * fills through the same deterministic option-verification as registry
 * keys. Only the promote resolver writes these — the model never does.
 */
export type CustomScreenerEntry = {
  answer: string;
  /** Normalized labels (screenerMatch.normalizeScreenerLabel) this covers. */
  labels: string[];
  promoted_at: string;
};

/** The operator's answers, keyed by registry key. Values are the LITERAL
 *  strings to type/pick — this file is authored by the human, once.
 *  `custom` holds promoted entries from the prediction review flow. */
export type ScreenerAnswerBank = {
  version: 1;
  answers: Record<string, string>;
  custom: Record<string, CustomScreenerEntry>;
};

export class ScreenerBankParseError extends Error {}

const CUSTOM_KEY_RE = /^[a-z0-9_]{2,60}$/;

export function parseScreenerBank(raw: unknown): ScreenerAnswerBank {
  if (typeof raw !== "object" || raw === null) {
    throw new ScreenerBankParseError("screeners.json must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj["version"] !== 1) {
    throw new ScreenerBankParseError('screeners.json needs "version": 1');
  }
  const answers = obj["answers"];
  if (typeof answers !== "object" || answers === null || Array.isArray(answers)) {
    throw new ScreenerBankParseError('screeners.json needs an "answers" object');
  }
  const known = new Set(SCREENER_REGISTRY.map((d) => d.key));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(answers as Record<string, unknown>)) {
    if (!known.has(k)) {
      throw new ScreenerBankParseError(
        `Unknown screener key "${k}" — valid keys: ${[...known].join(", ")}`,
      );
    }
    if (typeof v !== "string") {
      throw new ScreenerBankParseError(`Answer for "${k}" must be a string`);
    }
    out[k] = v;
  }

  const custom: Record<string, CustomScreenerEntry> = {};
  const rawCustom = obj["custom"];
  if (rawCustom !== undefined) {
    if (typeof rawCustom !== "object" || rawCustom === null || Array.isArray(rawCustom)) {
      throw new ScreenerBankParseError('"custom" must be an object when present');
    }
    for (const [k, v] of Object.entries(rawCustom as Record<string, unknown>)) {
      if (!CUSTOM_KEY_RE.test(k)) {
        throw new ScreenerBankParseError(
          `Custom key "${k}" must be snake_case [a-z0-9_], 2-60 chars`,
        );
      }
      if (known.has(k)) {
        throw new ScreenerBankParseError(
          `Custom key "${k}" collides with a registry key — use "answers" for it`,
        );
      }
      const e = v as Partial<CustomScreenerEntry> | null;
      if (
        typeof e !== "object" ||
        e === null ||
        typeof e.answer !== "string" ||
        e.answer.trim() === "" ||
        !Array.isArray(e.labels) ||
        e.labels.length === 0 ||
        !e.labels.every((l) => typeof l === "string" && l.trim() !== "")
      ) {
        throw new ScreenerBankParseError(
          `Custom entry "${k}" needs {answer: string, labels: string[]}`,
        );
      }
      custom[k] = {
        answer: e.answer,
        labels: e.labels.map((l) => l.trim()),
        promoted_at: typeof e.promoted_at === "string" ? e.promoted_at : "",
      };
    }
  }
  return { version: 1, answers: out, custom };
}

export function screenerDef(key: string): ScreenerDef | undefined {
  return SCREENER_REGISTRY.find((d) => d.key === key);
}
