import type {
  FieldFillMeta,
  FillResult,
  FormVerificationResult,
  UploadVerification,
} from "../ats/adapter.js";
import type { FillPlanEntry } from "./resolveAnswers.js";

export type OperatorFieldActionItem = {
  /** Stable id for sorting / review payloads */
  id: string;
  /** On-form question text when known */
  question: string;
  field_id: string | null;
  canonical_field: string | null;
  kind:
    | "verify_mismatch"
    | "fill_error"
    | "upload_failed"
    | "plan_review"
    | "plan_essay"
    | "plan_empty_profile"
    | "plan_demographics";
  /** One-line problem */
  problem: string;
  expected: unknown;
  observed: unknown;
  /** Concrete operator steps, in priority order */
  how_to_answer: string[];
};

export type OperatorFieldBrief = {
  title: string;
  summary: string;
  items: OperatorFieldActionItem[];
  ok_count: number;
  fail_count: number;
};

function displayValue(v: unknown): string {
  if (v === null || v === undefined) return "(empty)";
  if (typeof v === "string") return v.trim() === "" ? "(empty)" : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    if (typeof o.label === "string" && o.label.trim()) return o.label;
    if (typeof o.value === "string") {
      return o.value.trim() === "" ? "(empty)" : o.value;
    }
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

function looksLikeLocationQuestion(label: string, fieldId: string | null): boolean {
  const s = `${label} ${fieldId ?? ""}`.toLowerCase();
  return (
    /\blocation\b/.test(s) ||
    /\bcity\b/.test(s) ||
    /\bwhere are you\b/.test(s) ||
    /location-input/.test(s)
  );
}

function looksLikeYesNoValue(v: unknown): boolean {
  if (typeof v === "boolean") return true;
  if (typeof v !== "string") return false;
  return /^(yes|no|y|n)$/i.test(v.trim());
}

function profileHint(canonical: string | null): string | null {
  if (!canonical) return null;
  const map: Record<string, string> = {
    "legal_name.first": "public-profile.json → legal_name.first",
    "legal_name.last": "public-profile.json → legal_name.last",
    email: "public-profile.json → email",
    phone: "public-profile.json → phone",
    "address.city": "public-profile.json → address.city",
    "address.state": "public-profile.json → address.state",
    "address.line1": "public-profile.json → address.line1",
    "address.postal_code": "public-profile.json → address.postal_code",
    "address.country": "public-profile.json → address.country",
    "current_company": "public-profile.json → current_company",
    linkedin_url: "public-profile.json → linkedin_url",
    github_url: "public-profile.json → github_url",
    relocation: "public-profile.json → relocation",
    work_authorization: "public-profile.json → work_authorization",
    requires_sponsorship: "public-profile.json → requires_sponsorship",
    how_heard: "public-profile.json → how_heard",
  };
  return map[canonical] ?? `public-profile.json (key: ${canonical})`;
}

function verifyHowToAnswer(input: {
  question: string;
  fieldId: string | null;
  canonical: string | null;
  expected: unknown;
  observed: unknown;
  controlKind?: string | null;
}): string[] {
  const steps: string[] = [];
  const exp = displayValue(input.expected);
  const obs = displayValue(input.observed);
  const locQ = looksLikeLocationQuestion(input.question, input.fieldId);
  const yesNo = looksLikeYesNoValue(input.expected);

  if (locQ && yesNo) {
    steps.push(
      "MISMAPPED FIELD: location/city question was filled with a Yes/No (likely `relocation`). Fix aliases: map Location / Current location → address.city (not relocation).",
    );
    steps.push(
      "Put the city in public-profile.json address.city, re-run fill, then pick the Places suggestion if the field is a typeahead.",
    );
    steps.push(
      "Manual override: type your city on the form and select the dropdown suggestion so the control commits.",
    );
    return steps;
  }

  if (locQ || input.controlKind === "combobox") {
    steps.push(
      `Type the intended value on the form (planned: ${exp}). If a places/autocomplete list appears, select a matching suggestion; plain city text is enough when no list opens.`,
    );
  }

  if (obs === "(empty)" && exp !== "(empty)") {
    steps.push(
      `System expected "${exp}" but the page is empty after fill. Fix fill path, control type, or map; or enter the value manually and re-verify.`,
    );
  } else if (obs !== exp) {
    steps.push(
      `DOM shows "${obs}" but plan expected "${exp}". Correct the value on the form or fix profile/aliases so the plan matches the real answer.`,
    );
  }

  const hint = profileHint(input.canonical);
  if (hint) {
    steps.push(`Profile source: private/candidate/${hint}`);
  }
  if (input.canonical) {
    steps.push(
      `Alias check: private/candidate/answer-aliases.json phrases for "${input.canonical}" should match the on-form question text.`,
    );
  }
  if (steps.length === 0) {
    steps.push("Correct the field on the live form, or fix profile/aliases and re-run fill.");
  }
  return steps;
}

/**
 * Build a concise operator brief from plan + fill + verify outcomes.
 * Prefer calling this whenever verify fails or review is required —
 * CLI, pipeline, and submit all share it.
 */
export function buildOperatorFieldBrief(input: {
  context: string;
  verify?: FormVerificationResult | null;
  fill?: FillResult | null;
  /** Explicit upload check when verify.uploads is empty (submit path). */
  upload?: UploadVerification | null;
  planEntries?: Array<
    Pick<
      FillPlanEntry,
      | "field_id"
      | "label"
      | "canonical_field"
      | "action"
      | "value"
      | "reason"
      | "type"
    >
  >;
  /** Intentional skips (file/unmapped/empty/essay) — off by default. */
  includePlanGaps?: boolean;
  /** EEO skips — only with includePlanGaps; still off unless set. */
  includeDemographics?: boolean;
}): OperatorFieldBrief {
  const items: OperatorFieldActionItem[] = [];
  const metaByCanonical = new Map<string, FieldFillMeta>();
  const metaByFieldId = new Map<string, FieldFillMeta>();
  for (const m of input.fill?.field_meta ?? []) {
    if (m.canonical_field) metaByCanonical.set(m.canonical_field, m);
    metaByFieldId.set(m.field_id, m);
  }
  const planByCanonical = new Map(
    (input.planEntries ?? [])
      .filter((e) => e.canonical_field)
      .map((e) => [e.canonical_field as string, e]),
  );

  let okCount = 0;
  for (const row of input.verify?.fields ?? []) {
    if (row.match) {
      okCount += 1;
      continue;
    }
    const plan = planByCanonical.get(row.canonical_field);
    const meta =
      metaByCanonical.get(row.canonical_field) ??
      (plan ? metaByFieldId.get(plan.field_id) : undefined);
    const question =
      plan?.label?.trim() ||
      meta?.field_id ||
      row.canonical_field ||
      "(unknown question)";
    const fieldId = plan?.field_id ?? meta?.field_id ?? null;
    items.push({
      id: `verify:${row.canonical_field}`,
      question,
      field_id: fieldId,
      canonical_field: row.canonical_field,
      kind: "verify_mismatch",
      problem: `Expected "${displayValue(row.expected)}"; page shows "${displayValue(row.observed)}"`,
      expected: row.expected,
      observed: row.observed,
      how_to_answer: verifyHowToAnswer({
        question,
        fieldId,
        canonical: row.canonical_field,
        expected: row.expected,
        observed: row.observed,
        controlKind: meta?.control_kind ?? null,
      }),
    });
  }

  for (const err of input.fill?.errors ?? []) {
    items.push({
      id: `fill_error:${err.slice(0, 80)}`,
      question: "(fill error — see problem)",
      field_id: null,
      canonical_field: null,
      kind: "fill_error",
      problem: err,
      expected: null,
      observed: null,
      how_to_answer: [
        "Inspect the form control this error names; fix selector/control kind or answer that field manually.",
        "Re-run fill after fixing profile/aliases if the wrong value caused the error.",
      ],
    });
  }

  const uploads: UploadVerification[] = [
    ...(input.verify?.uploads ?? []),
    ...(input.upload &&
    !(input.verify?.uploads ?? []).some((u) => u.field === input.upload?.field)
      ? [input.upload]
      : []),
  ];
  for (const u of uploads) {
    if (u.verified) {
      okCount += 1;
      continue;
    }
    items.push({
      id: `upload:${u.field}`,
      question: `Upload: ${u.field}`,
      field_id: null,
      canonical_field: null,
      kind: "upload_failed",
      problem: u.evidence || "upload not verified on the page",
      expected: u.filename,
      observed: null,
      how_to_answer: [
        "Resume is system-owned: materials:register + adapter.uploadResume on submit/fill — not a free-text profile field.",
        "If this is ats:fill without --resume, pass --resume <pdf> or use application submit (uses registered material).",
        `Evidence: ${u.evidence}`,
      ],
    });
  }

  // Plan gaps: only when asked. Default brief = verify + fill errors + upload fails.
  if (input.includePlanGaps) {
    for (const e of input.planEntries ?? []) {
      const action = e.action;
      if (action === "fill") continue;
      if (action === "skip_file") {
        // Never blame the operator for file inputs in the plan; upload path owns them.
        continue;
      }
      if (action === "skip_essay" || action === "review_required") {
        const essay = action === "skip_essay" || e.type === "textarea";
        items.push({
          id: `plan:${e.field_id}`,
          question: e.label || e.field_id,
          field_id: e.field_id,
          canonical_field: e.canonical_field,
          kind: essay ? "plan_essay" : "plan_review",
          problem:
            e.reason ||
            (essay
              ? "Essay generation produced no answer"
              : "Requires human review"),
          expected: null,
          observed: null,
          how_to_answer: essay
            ? [
                "Essay autofill needs about-me.md + an LLM key, or write the answer yourself.",
                `CLI when app is ESSAY_REQUIRED: npm run resume:essay -- --application <id> --field ${e.field_id} --file answers.txt`,
                "Or answer on the live form before submit.",
              ]
            : [
                e.reason ||
                  "Operator must decide or supply a value for this field.",
                "Complete it on the form, or map it via answer-aliases + public-profile if it is a structured fact.",
              ],
        });
      } else if (action === "skip_empty") {
        items.push({
          id: `empty:${e.field_id}`,
          question: e.label || e.field_id,
          field_id: e.field_id,
          canonical_field: e.canonical_field,
          kind: "plan_empty_profile",
          problem: e.reason || "Profile has no value for this mapped field",
          expected: null,
          observed: null,
          how_to_answer: [
            profileHint(e.canonical_field)
              ? `Fill private/candidate/${profileHint(e.canonical_field)}`
              : "Add the missing fact to public-profile.json (or sensitive profile when applicable).",
            "Or type the answer on the form yourself.",
          ],
        });
      } else if (action === "skip_unmapped") {
        items.push({
          id: `unmap:${e.field_id}`,
          question: e.label || e.field_id,
          field_id: e.field_id,
          canonical_field: null,
          kind: "plan_review",
          problem: e.reason || "No answer-alias mapping for this field",
          expected: null,
          observed: null,
          how_to_answer: [
            "Add an alias phrase in answer-aliases.json that matches the label, or fill the field manually on the form.",
          ],
        });
      } else if (action === "skip_demographics" && input.includeDemographics) {
        items.push({
          id: `demo:${e.field_id}`,
          question: e.label || e.field_id,
          field_id: e.field_id,
          canonical_field: e.canonical_field,
          kind: "plan_demographics",
          problem:
            e.reason ||
            "Demographics / EEO — requires sensitive-profile mapping",
          expected: null,
          observed: null,
          how_to_answer: [
            "Put the value in private/candidate/sensitive-profile.draft.json (or encrypt with candidate:encrypt-sensitive).",
            "Map the field via answer-aliases (Race → race_ethnicity, Veteran status → veteran_status).",
            "Or answer personally on the form.",
          ],
        });
      }
    }
  }

  // Prefer verify rows over plan rows for the same field/canonical.
  const failedCanonicals = new Set(
    items
      .filter((it) => it.kind === "verify_mismatch" && it.canonical_field)
      .map((it) => it.canonical_field as string),
  );
  const failedFieldIds = new Set(
    items
      .filter((it) => it.kind === "verify_mismatch" && it.field_id)
      .map((it) => it.field_id as string),
  );
  const deduped = items.filter((it) => {
    if (it.kind === "verify_mismatch") return true;
    if (it.canonical_field && failedCanonicals.has(it.canonical_field))
      return false;
    if (it.field_id && failedFieldIds.has(it.field_id)) return false;
    return true;
  });

  const failCount = deduped.length;
  const summary =
    failCount === 0
      ? "No open field issues in this report."
      : `${failCount} item(s) need attention` +
        (input.verify && !input.verify.passed
          ? " (verify failed — submit click blocked)"
          : "");

  return {
    title: input.context,
    summary,
    items: deduped,
    ok_count: okCount,
    fail_count: failCount,
  };
}

/** Human terminal block — call with process.stderr.write or console.error. */
export function formatOperatorFieldBriefPlain(brief: OperatorFieldBrief): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("========== OPERATOR FIELD BRIEF ==========");
  lines.push(brief.title);
  lines.push(brief.summary);
  lines.push(`Matched/OK checks noted: ${brief.ok_count}`);
  if (brief.items.length === 0) {
    lines.push("(nothing for the operator to do from this report)");
    lines.push("==========================================");
    lines.push("");
    return lines.join("\n");
  }
  lines.push("");
  brief.items.forEach((item, i) => {
    lines.push(`${i + 1}. QUESTION: ${item.question}`);
    if (item.field_id) lines.push(`   Form field id: ${item.field_id}`);
    if (item.canonical_field)
      lines.push(`   Mapped as: ${item.canonical_field}`);
    lines.push(`   Kind: ${item.kind}`);
    lines.push(`   Problem: ${item.problem}`);
    if (item.expected !== null && item.expected !== undefined) {
      lines.push(`   Planned / expected: ${displayValue(item.expected)}`);
    }
    if (item.observed !== null && item.observed !== undefined) {
      lines.push(`   Observed on page: ${displayValue(item.observed)}`);
    }
    lines.push("   HOW TO ANSWER:");
    for (const step of item.how_to_answer) {
      lines.push(`   - ${step}`);
    }
    lines.push("");
  });
  lines.push("==========================================");
  lines.push("");
  return lines.join("\n");
}

export function printOperatorFieldBrief(brief: OperatorFieldBrief): void {
  process.stderr.write(formatOperatorFieldBriefPlain(brief));
}

/** Compact redacted-safe view for JSON reports / review payloads. */
export function operatorBriefForArtifact(
  brief: OperatorFieldBrief,
): OperatorFieldBrief {
  // Keep structure; values may still include planned text — logs already
  // redact email/phone when walkers run. Brief is operator-facing facts.
  return brief;
}
