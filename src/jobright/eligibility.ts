import { z } from "zod";

export type EligibilityCheck = {
  name: string;
  result: boolean;
  evidence: string;
};

export type EligibilityDecision = {
  eligible: boolean;
  checks: EligibilityCheck[];
  warnings: string[];
};

export const candidateEligibilityDefaults = {
  graduationYear: 2029,
  graduationMonth: "May",
  seeking: "internship" as const,
  level: "rising_sophomore_undergraduate" as const,
};

const HARD_EXCLUSION_PATTERNS: Array<{ name: string; re: RegExp }> = [
  {
    name: "grad_students_only",
    re: /\b(ph\.?d|masters?|graduate students? only|current (ms|phd) students?)\b/i,
  },
  {
    name: "seniors_only_explicit",
    re: /\b(graduating (in )?(2026|2027)|class of 202[67]|seniors? only)\b/i,
  },
  {
    name: "clearance_required",
    re: /\b(active (ts\/?sci|secret) clearance required|must (hold|have) .*clearance)\b/i,
  },
  {
    name: "years_experience_hard",
    re: /\b(minimum|at least|requires?)\s+([3-9]|[1-9]\d)\+?\s+years?\s+(of\s+)?(professional\s+)?experience\b/i,
  },
];

/**
 * Lightweight eligibility — reject only clear conflicts.
 * Do not rank competitiveness.
 */
export function evaluateEligibility(input: {
  role: string;
  employmentType?: string | null;
  description?: string | null;
  alreadySubmitted?: boolean;
}): EligibilityDecision {
  const text = [input.role, input.employmentType ?? "", input.description ?? ""]
    .join("\n")
    .trim();
  const checks: EligibilityCheck[] = [];
  const warnings: string[] = [];

  const internship =
    /intern|internship|co-?op/i.test(input.role) ||
    /intern|internship|co-?op/i.test(input.employmentType ?? "") ||
    /\binternship\b/i.test(input.description ?? "");

  checks.push({
    name: "internship",
    result: internship,
    evidence: internship
      ? `Matched internship signal in role/type: ${input.role}`
      : `No internship signal in role/type: ${input.role}`,
  });

  const excludes2029 =
    /\b(class of 202[0-8]\b|graduat(e|ing) (by|in|before) 202[0-8]|must graduate (in|by) 202[0-8])/i.test(
      text,
    ) && !/2029/.test(text);

  const allowsUndergrad =
    !/\b(ph\.?d|masters? only|graduate students? only)\b/i.test(text) ||
    /\b(bachelor|undergraduate|undergrad)\b/i.test(text);

  checks.push({
    name: "graduation_year",
    result: !excludes2029 && allowsUndergrad,
    evidence: excludes2029
      ? "Description appears to exclude May 2029 graduates"
      : allowsUndergrad
        ? "No conflicting graduation-year exclusion for May 2029"
        : "Description appears graduate-only",
  });

  for (const pattern of HARD_EXCLUSION_PATTERNS) {
    const match = text.match(pattern.re);
    checks.push({
      name: `hard_exclusion:${pattern.name}`,
      result: !match,
      evidence: match ? `Matched: ${match[0]}` : "No match",
    });
  }

  checks.push({
    name: "not_already_submitted",
    result: !input.alreadySubmitted,
    evidence: input.alreadySubmitted
      ? "Job already marked submitted"
      : "Not previously submitted",
  });

  if (/competitive|highly selective/i.test(text)) {
    warnings.push("Competitive language present — not used as rejection.");
  }

  const eligible = checks.every((c) => c.result);
  return { eligible, checks, warnings };
}

export const eligibilityDecisionSchema = z.object({
  eligible: z.boolean(),
  checks: z.array(
    z.object({
      name: z.string(),
      result: z.boolean(),
      evidence: z.string(),
    }),
  ),
  warnings: z.array(z.string()),
});
