import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config/index.js";
import { writeJsonAtomic } from "../storage/atomicJson.js";
import { recordFillRun } from "../storage/fillOutcomes.js";
import { loadAnswerAliases } from "../candidate/answerAliases.js";
import { loadPublicProfile } from "../candidate/publicProfileIO.js";
import {
  getProfileValue,
  type PublicProfile,
} from "../candidate/publicProfile.js";
import { GreenhouseAdapterV1 } from "../ats/greenhouse/v1.js";
import { LeverAdapterV1, leverFullNameMatcher } from "../ats/lever/v1.js";
import { AshbyAdapterV1, ashbyFullNameMatcher } from "../ats/ashby/v1.js";
import { WorkableAdapterV1 } from "../ats/workable/v1.js";
import { GenericAdapterV1 } from "../ats/generic/v1.js";
import {
  heldAnswerFromReason,
  isOptionMismatchReview,
  selectScreenerOptions,
  type OptionSelectItem,
} from "./screenerOptionSelect.js";
import {
  essayAutofillAvailable,
  extractPostingContext,
  generateEssayAnswers,
  mergePostingContext,
} from "./essayAutofill.js";
import { essayFieldsOnly } from "./essayDetector.js";
import { postSandboxTrace } from "../sandbox/trace.js";
import { logger } from "../logging/logger.js";
import type { EmailLlmClient } from "../contacts/emailLlm.js";
import { WorkdayAdapterV1 } from "../ats/workday/v1.js";
import {
  annotateFullNameField,
  type FullNameFieldMatcher,
} from "../ats/shared/nameComposition.js";
import { detectAts } from "../ats/registry.js";
import {
  applyHarvestedOptions,
  findOtherOption,
  type AnswerSpace,
} from "../ats/shared/optionHarvest.js";
import {
  mapDiscoveredFields,
  type MappedField,
} from "./fieldNormalization.js";
import { buildFillPlan } from "./resolveAnswers.js";
import { toApprovedFillPlan } from "./approvedFillPlan.js";
import { assertFormFillAllowed } from "./formFillGuards.js";
import {
  loadAtsFixture,
  type AtsFixtureName,
} from "./atsFixtureInspect.js";
import { withFixtureHtmlPage } from "../browser/fixtureSession.js";
import { redactFillReportForArtifact } from "./fillReportRedaction.js";
import type { Db } from "../storage/db/client.js";
import type {
  ApplicationAdapter,
  DiscoveredField,
  FillResult,
  FormResetResult,
  FormVerificationResult,
  ResolvedApplicationAnswers,
  UploadVerification,
} from "../ats/adapter.js";
import type { Page } from "playwright";
import type { FillPlanEntry } from "./resolveAnswers.js";
import {
  attachCustomScreenerLabel,
  tryLoadScreenerBank,
} from "../candidate/screenersIO.js";
import {
  matchScreenerKey,
  resolveCustomScreener,
  resolveScreenerForField,
  screenerKeyFitsField,
  type ScreenerResolution,
} from "../candidate/screenerMatch.js";
import { mapScreenerLabels } from "./screenerLlmMap.js";
import {
  isCaptureWorthyQuestion,
  predictAnswersForQuestions,
  recordUnmappedScreenerQuestions,
} from "./screenerPredictionLlm.js";
import { isApplicationConsentField } from "./consentFields.js";
import { isDemographicsField as screenerIsDemographic } from "./essayDetector.js";
import type { ApprovedFillPlan } from "./approvedFillPlan.js";
import type { FieldMeta } from "../ats/greenhouse/fill.js";
import { buildHumanEssayEntries } from "./essayFill.js";
import { greenhouseFillEssays } from "../ats/greenhouse/essayFill.js";
import { pickOptionLabel } from "../ats/greenhouse/comboboxFill.js";

/**
 * Fill-capable adapters. The base ApplicationAdapter interface leaves
 * fill methods optional because the leftover unsupported adapter has
 * none — fill never uses that adapter; unmatched pages use generic.
 */
export type FillCapableAdapter = ApplicationAdapter & {
  setFillContext(entries: FillPlanEntry[], fields: DiscoveredField[]): void;
  setApprovedFillPlan(plan: ApprovedFillPlan, profile?: PublicProfile): void;
  fill(page: Page, answers: ResolvedApplicationAnswers): Promise<FillResult>;
  verify(
    page: Page,
    expected: ResolvedApplicationAnswers,
  ): Promise<FormVerificationResult>;
  uploadResume(page: Page, resumePath: string): Promise<UploadVerification>;
  resetForm(page: Page): Promise<FormResetResult>;
  uploadCoverLetter?(
    page: Page,
    coverLetterPath: string,
  ): Promise<UploadVerification>;
};

/** Fresh instance per run — the registry's singletons must not carry plan state. */
const FILLABLE_ADAPTERS: Record<string, () => FillCapableAdapter> = {
  greenhouse: () => new GreenhouseAdapterV1(),
  lever: () => new LeverAdapterV1(),
  ashby: () => new AshbyAdapterV1(),
  workable: () => new WorkableAdapterV1(),
  workday: () => new WorkdayAdapterV1(),
  // The long tail: any company-hosted form. Last resort by construction —
  // detectAtsFromUrl only reports "generic" after every vendor declines.
  generic: () => new GenericAdapterV1(),
};

/** Single full-name fields need annotation before planning (see nameComposition). */
const FULL_NAME_MATCHERS: Record<string, FullNameFieldMatcher> = {
  lever: leverFullNameMatcher,
  ashby: ashbyFullNameMatcher,
};

/**
 * Alias/profile mapping is greedy: "organization" inside a Yes/No
 * question becomes current_company. If the control's own list cannot
 * hold that value and has no Other, the mapping is wrong — drop it so
 * predict answers the question that is actually on the page.
 */
export function releaseUnplaceableProfileMappings(
  mapped: MappedField[],
  profile: PublicProfile,
): void {
  for (const f of mapped) {
    if (!f.canonical_field) continue;
    if (screenerIsDemographic(f)) continue;
    const options = (f.options ?? []).filter(
      (o) => o.trim() !== "" && !/^select\b/i.test(o.trim()),
    );
    if (options.length < 2) continue;
    const raw = getProfileValue(profile, f.canonical_field);
    if (raw === undefined || raw === null || raw === "") continue;
    if (pickOptionLabel(options, String(raw)).ok) continue;
    if (findOtherOption(f.options ?? [])) continue;
    f.canonical_field = null;
    f.mapping_confidence = "none";
  }
}

/**
 * Fixtures runAtsFixtureFill will execute against ("essay" is a
 * greenhouse-form fixture used by the human-essay path). The CLI imports
 * this — one list, no drift.
 */
export const FILLABLE_FIXTURE_NAMES: readonly string[] = [
  "greenhouse",
  "essay",
  "lever",
  "ashby",
];

export type ApplicationFillReport = {
  mode: "plan_only" | "executed";
  ats: string;
  url: string;
  plan: ReturnType<typeof buildFillPlan>;
  approved_plan?: ReturnType<typeof toApprovedFillPlan>;
  fill?: FillResult;
  /** Human-authored essay answers only; absent when none were provided. */
  essay_fill?: FillResult;
  verify?: FormVerificationResult;
  uploads?: UploadVerification[];
  reset?: FormResetResult;
  submit_attempted: false;
  notes: string[];
  report_path?: string;
  operator_brief?: import("./operatorFieldBrief.js").OperatorFieldBrief;
};

/**
 * A closed field answered with the form's own "Other" option because the
 * candidate's real answer was not among the choices. `intended` is that
 * real answer — it belongs in the free-text box such forms reveal once
 * "Other" is chosen (see fillOtherSpecify).
 */
export type OtherFallback = {
  field_id: string;
  label: string;
  chose: string;
  intended: string | null;
};

export async function planApplicationFill(input: {
  url: string;
  html: string;
  profile?: PublicProfile;
  /**
   * When set, questions nothing could answer are captured into the
   * prediction queue AND surfaced as "Answer needed" review items carrying
   * this application (so the console shows company/role next to the
   * question). Absent (fixture/plan-only paths), nothing is written.
   */
  capture?: { db: Db; applicationId: string | null };
  /**
   * Options scraped from the LIVE controls (see optionHarvest.ts). The
   * HTML alone cannot see a React-select's list, so without this every
   * dropdown reaches the planner with an empty answer space and every
   * downstream tier degrades to blind free-text. Absent on fixture and
   * plan-only paths, which have no live page to open.
   */
  liveOptions?: Map<string, string[]>;
  /**
   * field id → CLOSED (choose from the list only) vs OPEN (type anything).
   * Recorded by the same live probe. A closed field whose answer is not on
   * the list takes the form's own "Other" escape hatch instead of typing a
   * string the control will reject.
   */
  answerSpace?: Map<string, AnswerSpace>;
  /**
   * Test seam (predictive gauntlet): injected LLM client for the
   * option-select and predict tiers. Production always builds its own from
   * the configured key; both tiers stay behind their flags either way.
   */
  llmClient?: EmailLlmClient;
  /**
   * Employer/role text harvested from pages the flow ALREADY walked
   * (posting page, iframe outer shell) — see extractPostingContext. The
   * form page itself is extracted here and merged in, so callers only
   * need to pass what this function cannot see. Grounds "why us" essays;
   * without it "Why <company>?" is unanswerable by construction (live
   * artifacts 1787010568814/1787010626392 shipped a BLANK essay).
   */
  postingContext?: string;
}): Promise<{
  adapter: FillCapableAdapter;
  plan: ReturnType<typeof buildFillPlan>;
  approvedPlan: ReturnType<typeof toApprovedFillPlan>;
  fields: DiscoveredField[];
  /** Closed fields answered "Other" — and the answer that belongs in the
   * text box the form reveals next. Consumed by the other-specify sweep. */
  otherFallbacks: OtherFallback[];
}> {
  const { adapter: detected } = await detectAts({
    url: input.url,
    html: input.html,
  });
  // Vendor adapters win on their own hosts. Everything else — including
  // a page HTML detection used to call "unsupported" — uses generic.
  // Live 2026-08-19: Paylocity Apply had no `<form>` wrapper, detectAts
  // returned unsupported, and this throw killed a form that was already
  // on screen. Mutation stays behind the fill flags.
  const makeAdapter =
    FILLABLE_ADAPTERS[detected.id] ?? (() => new GenericAdapterV1());
  const adapter = makeAdapter();
  const discovered = await adapter.discoverFields({ html: input.html });
  // Give every tier below the real answer space before it decides anything.
  const fields = input.liveOptions
    ? applyHarvestedOptions(discovered, input.liveOptions)
    : discovered;
  const aliases = loadAnswerAliases();
  const nameMatcher = FULL_NAME_MATCHERS[adapter.id];
  const mapped = nameMatcher
    ? annotateFullNameField(mapDiscoveredFields(fields, aliases), nameMatcher)
    : mapDiscoveredFields(fields, aliases);
  const profile = input.profile ?? loadPublicProfile();
  // A Yes/No (or any closed list) that aliases mapped to a profile fact
  // whose value is not on the list is not a profile field. Drop the
  // mapping so predict can answer the question that is actually there.
  releaseUnplaceableProfileMappings(mapped, profile);

  // Screener pass for otherwise-unmapped fields: deterministic patterns
  // first; the flag-gated LLM assist maps only the leftovers (labels +
  // options + registry descriptions — never answers). Every mapping still
  // resolves through the deterministic option-verified bank path.
  // Consent / major-option checkboxes / inspector placeholders are not
  // questions — they must not drown the Answer-needed queue.
  const screenerResolutions = new Map<string, ScreenerResolution>();
  const bank = tryLoadScreenerBank();
  const candidates = mapped.filter(
    (f) =>
      !f.canonical_field &&
      f.type !== "textarea" &&
      f.type !== "file" &&
      !screenerIsDemographic(f) &&
      !isApplicationConsentField(f) &&
      isCaptureWorthyQuestion(f),
  );
  if (bank) {
    const unmatchedForLlm: typeof candidates = [];
    for (const f of candidates) {
      if (matchScreenerKey(f.label)) {
        const r = resolveScreenerForField(
          { label: f.label, type: f.type, options: f.options },
          bank,
          undefined,
          profile,
        );
        if (r) screenerResolutions.set(f.id, r);
        continue;
      }
      // Custom bank: exact or high-overlap question label. A hit
      // compounds the new wording onto the entry so the next form is exact.
      const custom = resolveCustomScreener(
        { label: f.label, type: f.type, options: f.options },
        bank,
      );
      if (custom) {
        screenerResolutions.set(f.id, custom);
        const rawKey = custom.key.startsWith("custom:")
          ? custom.key.slice("custom:".length)
          : custom.key;
        try {
          attachCustomScreenerLabel(rawKey, f.label);
        } catch {
          // compounding the label is best-effort
        }
        continue;
      }
      unmatchedForLlm.push(f);
    }
    if (unmatchedForLlm.length > 0) {
      const mappings = await mapScreenerLabels({
        ats: adapter.id,
        labels: unmatchedForLlm.map((f) => ({
          label: f.label,
          options: f.options,
        })),
      });
      const byLabel = new Map(mappings.map((m) => [m.label, m.key]));
      for (const f of unmatchedForLlm) {
        const key = byLabel.get(f.label);
        if (!key || !screenerKeyFitsField(key, f)) continue;
        const r = resolveScreenerForField(
          { label: f.label, type: f.type, options: f.options },
          bank,
          key,
          profile,
        );
        if (r) screenerResolutions.set(f.id, r);
      }
    }
  }

  const otherFallbacks: OtherFallback[] = [];
  const unanswered = candidates.filter((f) => !screenerResolutions.has(f.id));
  if (unanswered.length > 0) {
    try {
      const predicted = await predictAnswersForQuestions(
        unanswered.map((f) => ({
          id: f.id,
          label: f.label,
          options: f.options,
        })),
        input.llmClient,
        input.url,
      );
      for (const [id, p] of predicted) {
        screenerResolutions.set(id, {
          status: "fill",
          key: `custom:predicted:${id}`,
          value: p.value,
          basis: p.intended ? "other_option" : "llm_predict",
          rationale: p.basis,
        });
        // The model's real answer was not on the list, so it chose the
        // form's "Other". Remember what it actually meant — that goes in
        // the specify box the form reveals next.
        if (p.intended) {
          const field = unanswered.find((f) => f.id === id);
          otherFallbacks.push({
            field_id: id,
            label: field?.label ?? id,
            chose: p.value,
            intended: p.intended,
          });
        }
      }
    } catch {
      // plan-time predict is best-effort; a model error must never break a plan
    }
  }

  const unmappedReasons = new Map<string, string>();
  if (getConfig().screenerPredictLlmEnabled) {
    for (const f of unanswered) {
      if (!screenerResolutions.has(f.id)) {
        unmappedReasons.set(f.id, "Predict produced no usable answer");
      }
    }
  }

  const stillUnmapped = candidates.filter((f) => !screenerResolutions.has(f.id));
  // Capture even with no screener bank on disk — otherwise unanswered
  // questions vanish. Fixture/plan-only paths omit `capture`.
  if (stillUnmapped.length > 0 && input.capture) {
    try {
      recordUnmappedScreenerQuestions({
        db: input.capture.db,
        applicationId: input.capture.applicationId,
        ats: adapter.id,
        questions: stillUnmapped.map((f) => ({
          label: f.label,
          type: f.type,
          options: f.options,
        })),
      });
    } catch {
      // capture is best-effort; a queue error must never break a plan
    }
  }

  // Last screener tier: an answer we HOLD that the literal matcher could
  // not place on the page's option list. One batched call; the model may
  // only choose from the page's own options and its choice is validated
  // verbatim, so it cannot invent one. Abstention parks exactly as before.
  if (screenerResolutions.size > 0) {
    const mismatched: OptionSelectItem[] = [];
    for (const [fieldId, resolution] of screenerResolutions) {
      if (!isOptionMismatchReview(resolution)) continue;
      const field = mapped.find((f) => f.id === fieldId);
      const answer = heldAnswerFromReason(resolution.reason);
      if (!field || !answer || (field.options?.length ?? 0) === 0) continue;
      mismatched.push({
        key: fieldId,
        question: field.label,
        answer,
        options: field.options ?? [],
      });
    }
    if (mismatched.length > 0) {
      const chosen = await selectScreenerOptions({
        items: mismatched,
        ...(input.llmClient ? { client: input.llmClient } : {}),
        traceUrl: input.url,
      });
      for (const c of chosen) {
        const prior = screenerResolutions.get(c.key);
        screenerResolutions.set(c.key, {
          status: "fill",
          key: prior && "key" in prior ? prior.key : c.key,
          value: c.option,
          basis: "llm_option",
        });
      }
    }
  }

  // "Other" escape hatch (operator directive 2026-08-14). A CLOSED field
  // whose answer space we scraped, whose true answer is genuinely not on
  // the list, and which offers "Other" — that is the form telling us what
  // to do when our answer is not listed. Choosing it is following the
  // form's own instruction, not guessing, so it fills; the true answer is
  // carried forward for the free-text box the form reveals next (Appian:
  // the university-organizations dropdown listed no real organization,
  // only "Other", and the run instead typed a name the list rejected).
  //
  // Deliberately last: every tier that could produce a REAL option answer
  // has already run. This only rescues fields that would otherwise park.
  for (const [fieldId, resolution] of screenerResolutions) {
    if (!isOptionMismatchReview(resolution)) continue;
    if (input.answerSpace && input.answerSpace.get(fieldId) !== "closed") continue;
    const field = mapped.find((f) => f.id === fieldId);
    const options = field?.options ?? [];
    if (!field || options.length === 0) continue;
    const other = findOtherOption(options);
    if (!other) continue;
    const intended = heldAnswerFromReason(resolution.reason);
    screenerResolutions.set(fieldId, {
      status: "fill",
      key: resolution.key,
      value: other,
      basis: "other_option",
    });
    otherFallbacks.push({
      field_id: fieldId,
      label: field.label,
      chose: other,
      intended: intended ?? null,
    });
  }
  if (otherFallbacks.length > 0) {
    logger.info("closed fields answered via the form's own Other option", {
      service: "screeners",
      action: "other_fallback",
      metadata: {
        count: otherFallbacks.length,
        labels: otherFallbacks.map((o) => o.label.slice(0, 60)),
      },
    });
  }

  // Essays fill from about-me.md when the LLM path is already on
  // (ESSAY_AUTOFILL_ENABLED or SCREENER_PREDICT_LLM_ENABLED). Off / no
  // context / rejected draft ⇒ skip with the real reason, not a policy lie.
  const essayAnswers = new Map<string, string>();
  const essayNotes: string[] = [];
  const essayIds = new Set(
    essayFieldsOnly(mapped)
      .filter((e) => e.is_essay)
      .map((e) => e.field_id),
  );
  const essayFields = mapped.filter(
    (f) =>
      (essayIds.has(f.id) || f.type === "textarea") &&
      (f.label ?? "").trim().length > 0,
  );
  const essayAvail = essayAutofillAvailable();
  if (essayFields.length > 0 && !essayAvail.ok) {
    essayNotes.push(`essay autofill skipped: ${essayAvail.reason}`);
    await postSandboxTrace(input.url, {
      kind: "essay skip",
      lines: [`essay autofill skipped: ${essayAvail.reason}`],
    });
  }
  if (essayFields.length > 0 && essayAvail.ok) {
    const generated = await generateEssayAnswers({
      items: essayFields.map((f) => ({ fieldId: f.id, question: f.label })),
      postingContext: mergePostingContext(
        input.postingContext,
        extractPostingContext(input.html),
      ),
      ...(input.llmClient ? { client: input.llmClient } : {}),
      traceUrl: input.url,
    });
    essayNotes.push(...generated.notes);
    for (const a of generated.answers) essayAnswers.set(a.fieldId, a.answer);
  }
  for (const note of essayNotes) {
    logger.info("essay autofill note", {
      service: "essays",
      action: "autofill_note",
      metadata: { note },
    });
  }

  const plan = buildFillPlan(mapped, profile, {
    screenerResolutions,
    ...(essayAnswers.size > 0 ? { essayAnswers } : {}),
    ...(essayFields.length > 0 && essayAnswers.size === 0
      ? {
          essaySkipReason:
            essayNotes[0] ?? "Essay generation produced no answer",
        }
      : {}),
    ...(unmappedReasons.size > 0 ? { unmappedReasons } : {}),
  });

  // Off-list PROFILE values on closed fields take the form's "Other" too.
  // The screener pass above only covers screener-resolved fields; a field
  // the ALIASES mapped (school, city…) is filled from the profile inside
  // buildFillPlan — and when that value is not on the control's list, the
  // fill-time option matcher refuses and the field stays empty. Live
  // (neuralink, run 2a9f9930): the relocation combobox got the profile's
  // "Baltimore, Maryland…" — "no option matches", blank field. The check
  // here uses the SAME matcher fill-time uses (pickOptionLabel, with all
  // its degree/location/yes-no synonym tiers), so a value that fill-time
  // WOULD place is left alone; only a value that is provably going to fail
  // is diverted to the form's own escape hatch. Demographics never divert
  // — a wrong guess there puts words in the candidate's mouth.
  for (const entry of plan.entries) {
    // Plan-level actions are lowercase ("fill"); the approved plan
    // uppercases later. Compare case-blind so this pass sees them.
    if (String(entry.action).toUpperCase() !== "FILL") continue;
    if (entry.value === undefined || entry.value === null) continue;
    const field = mapped.find((f) => f.id === entry.field_id);
    const options = field?.options ?? [];
    if (!field || options.length < 2) continue;
    if (screenerIsDemographic(field)) continue;
    if (otherFallbacks.some((o) => o.field_id === entry.field_id)) continue;
    const pick = pickOptionLabel(options, String(entry.value));
    if (pick.ok) {
      if (pick.label !== String(entry.value)) {
        entry.reason = `${entry.reason}; placed onto "${pick.label}"`;
        entry.value = pick.label;
      }
      continue;
    }
    const other = findOtherOption(options);
    if (!other) continue; // no escape hatch — fill-time refuses honestly
    const intended = String(entry.value);
    entry.value = other;
    entry.reason = `${entry.reason}; value "${intended.slice(0, 40)}" not on the control's list — using the form's own "${other}"`;
    otherFallbacks.push({
      field_id: entry.field_id,
      label: entry.label,
      chose: other,
      intended,
    });
  }

  const approvedPlan = toApprovedFillPlan(plan.entries);
  adapter.setFillContext(plan.entries, fields);
  adapter.setApprovedFillPlan(approvedPlan, profile);
  // Lever/Ashby rewrite the plan during setApprovedFillPlan (full-name
  // composition) — report the plan the adapter will actually execute.
  const composed =
    (
      adapter as { getApprovedFillPlan?: () => ApprovedFillPlan | null }
    ).getApprovedFillPlan?.() ?? approvedPlan;
  return { adapter, plan, approvedPlan: composed, fields, otherFallbacks };
}

export async function runApplicationFill(input: {
  url: string;
  html: string;
  execute: boolean;
  profile?: PublicProfile;
  resumePath?: string;
  coverLetterPath?: string;
  resetAfter?: boolean;
  artifactName?: string;
  /**
   * When set, textareas classified as essays are filled from human-authored
   * application_answers rows (resume-essay). This is the only essay path;
   * the approved plan continues to reject textareas unconditionally.
   */
  includeHumanEssays?: { db: Db; applicationId: string };
}): Promise<ApplicationFillReport> {
  const notes: string[] = [];
  const { adapter, plan, approvedPlan, fields } =
    await planApplicationFill(input);

  if (!input.execute) {
    notes.push("plan_only — set --execute with FORM_FILL_ENABLED=true and DRY_RUN=false to mutate");
    const report: ApplicationFillReport = {
      mode: "plan_only",
      ats: adapter.id,
      url: input.url,
      plan,
      approved_plan: approvedPlan,
      submit_attempted: false,
      notes,
    };
    return persistFillReport(report, input.artifactName ?? "plan");
  }

  assertFormFillAllowed("applicationFiller.execute");

  return withFixtureHtmlPage(input.html, async (page) => {
    const fill = await adapter.fill(page, approvedPlan.answers);

    let essayFill: FillResult | undefined;
    if (input.includeHumanEssays) {
      const { db, applicationId } = input.includeHumanEssays;
      const essayEntries = buildHumanEssayEntries(db, applicationId, fields);
      if (essayEntries.length > 0 && adapter.id !== "greenhouse") {
        notes.push(
          `essay answers present but ${adapter.id} essay fill is not wired — left unfilled for human review`,
        );
      } else if (essayEntries.length > 0) {
        const fieldMeta = new Map<string, FieldMeta>(
          fields.map((f) => {
            const meta: FieldMeta = { type: f.type };
            if (f.name) meta.name = f.name;
            if (f.inputId) meta.inputId = f.inputId;
            return [f.id, meta] as const;
          }),
        );
        essayFill = await greenhouseFillEssays(page, essayEntries, fieldMeta, db);
        notes.push(
          `human essay answers filled: ${essayFill.filled.length} (source: resume-essay)`,
        );
      }
    }

    const verify = await adapter.verify(page, approvedPlan.answers);
    const uploads = [];
    if (input.resumePath) {
      uploads.push(await adapter.uploadResume(page, input.resumePath));
    }
    if (input.coverLetterPath) {
      if (adapter.uploadCoverLetter) {
        uploads.push(
          await adapter.uploadCoverLetter(page, input.coverLetterPath),
        );
      } else {
        notes.push(
          `cover letter skipped — ${adapter.id} has no cover-letter file input`,
        );
      }
    }
    let reset;
    if (input.resetAfter) {
      reset = await adapter.resetForm(page);
    }
    notes.push("submit not called — Phase 5 forbids submission");
    const report: ApplicationFillReport = {
      mode: "executed",
      ats: adapter.id,
      url: input.url,
      plan,
      approved_plan: approvedPlan,
      fill,
      ...(essayFill ? { essay_fill: essayFill } : {}),
      verify,
      ...(uploads.length ? { uploads } : {}),
      ...(reset ? { reset } : {}),
      submit_attempted: false,
      notes,
    };
    return persistFillReport(report, input.artifactName ?? "execute");
  });
}

export async function runAtsFixtureFill(
  name: AtsFixtureName,
  opts: {
    execute: boolean;
    profile?: PublicProfile;
    resumePath?: string;
    coverLetterPath?: string;
    resetAfter?: boolean;
    includeHumanEssays?: { db: Db; applicationId: string };
  },
): Promise<ApplicationFillReport> {
  if (!FILLABLE_FIXTURE_NAMES.includes(name)) {
    throw new Error(
      `Execute/fill fixtures are limited to ${FILLABLE_FIXTURE_NAMES.join("/")} (got "${name}"). Use ats:inspect for other fixtures.`,
    );
  }
  const fixture = loadAtsFixture(name);
  return runApplicationFill({
    ...fixture,
    execute: opts.execute,
    ...(opts.profile ? { profile: opts.profile } : {}),
    ...(opts.resumePath ? { resumePath: opts.resumePath } : {}),
    ...(opts.coverLetterPath ? { coverLetterPath: opts.coverLetterPath } : {}),
    ...(opts.includeHumanEssays
      ? { includeHumanEssays: opts.includeHumanEssays }
      : {}),
    resetAfter: opts.resetAfter ?? false,
    artifactName: name,
  });
}

function persistFillReport(
  report: ApplicationFillReport,
  name: string,
): ApplicationFillReport {
  const cfg = getConfig();
  const outDir = path.join(cfg.artifactsDir, "ats-fill", name);
  fs.mkdirSync(outDir, { recursive: true });
  const reportPath = path.join(
    outDir,
    report.mode === "plan_only" ? "fill-plan.json" : "fill-report.json",
  );

  if (report.mode === "executed") {
    const planEntries = (
      report.approved_plan?.entries ?? report.plan.entries
    ).map((e) => {
      const base = {
        field_id: e.field_id,
        label: e.label,
        type: e.type as string,
        canonical_field: e.canonical_field ?? null,
        action: String(e.action),
        value: e.value,
        reason: e.reason,
      };
      if (
        "approved" in e &&
        typeof (e as { approved?: boolean }).approved === "boolean"
      ) {
        return {
          ...base,
          approved: (e as { approved: boolean }).approved,
        };
      }
      return base;
    });
    recordFillRun({
      mode: "executed",
      source: "fixture",
      ats: report.ats,
      job_url: report.url,
      mutation_attempted: true,
      validation_level: report.verify?.passed
        ? "FIXTURE_CONFIRMED"
        : "UNVERIFIED",
      fillable_count:
        report.approved_plan?.fillable_count ?? report.plan.fillable_count,
      skipped_count:
        report.approved_plan?.skipped_count ?? report.plan.skipped_count,
      report_artifact_relpath: path.relative(cfg.artifactsDir, reportPath),
      notes: report.notes,
      plan_entries: planEntries,
      fill: report.fill ?? null,
      verify: report.verify ?? null,
      uploads: report.uploads ?? null,
      heal: null,
    });
  }

  const redacted = redactFillReportForArtifact({
    ...report,
    written_at: new Date().toISOString(),
  });
  writeJsonAtomic(reportPath, redacted);
  return { ...report, report_path: reportPath };
}
