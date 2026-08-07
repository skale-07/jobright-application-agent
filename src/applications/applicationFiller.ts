import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config/index.js";
import { writeJsonAtomic } from "../storage/atomicJson.js";
import { recordFillRun } from "../storage/fillOutcomes.js";
import { loadAnswerAliases } from "../candidate/answerAliases.js";
import { loadPublicProfile } from "../candidate/publicProfileIO.js";
import type { PublicProfile } from "../candidate/publicProfile.js";
import { GreenhouseAdapterV1 } from "../ats/greenhouse/v1.js";
import { mapDiscoveredFields } from "./fieldNormalization.js";
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
import type { FillResult } from "../ats/adapter.js";
import type { FieldMeta } from "../ats/greenhouse/fill.js";
import { buildHumanEssayEntries } from "./essayFill.js";
import { greenhouseFillEssays } from "../ats/greenhouse/essayFill.js";

export type ApplicationFillReport = {
  mode: "plan_only" | "executed";
  ats: string;
  url: string;
  plan: ReturnType<typeof buildFillPlan>;
  approved_plan?: ReturnType<typeof toApprovedFillPlan>;
  fill?: Awaited<ReturnType<GreenhouseAdapterV1["fill"]>>;
  /** Human-authored essay answers only; absent when none were provided. */
  essay_fill?: FillResult;
  verify?: Awaited<ReturnType<GreenhouseAdapterV1["verify"]>>;
  uploads?: Awaited<ReturnType<GreenhouseAdapterV1["uploadResume"]>>[];
  reset?: Awaited<ReturnType<GreenhouseAdapterV1["resetForm"]>>;
  submit_attempted: false;
  notes: string[];
  report_path?: string;
};

export async function planApplicationFill(input: {
  url: string;
  html: string;
  profile?: PublicProfile;
}): Promise<{
  adapter: GreenhouseAdapterV1;
  plan: ReturnType<typeof buildFillPlan>;
  approvedPlan: ReturnType<typeof toApprovedFillPlan>;
  fields: Awaited<ReturnType<GreenhouseAdapterV1["discoverFields"]>>;
}> {
  const adapter = new GreenhouseAdapterV1();
  const detection = await adapter.detect(input);
  if (!detection.matched) {
    throw new Error(
      `Phase 5 fill supports Greenhouse only — detection failed (${detection.evidence.join("; ") || "no evidence"})`,
    );
  }
  const fields = await adapter.discoverFields({ html: input.html });
  const aliases = loadAnswerAliases();
  const mapped = mapDiscoveredFields(fields, aliases);
  const profile = input.profile ?? loadPublicProfile();
  const plan = buildFillPlan(mapped, profile);
  const approvedPlan = toApprovedFillPlan(plan.entries);
  adapter.setFillContext(plan.entries, fields);
  adapter.setApprovedFillPlan(approvedPlan);
  return { adapter, plan, approvedPlan, fields };
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
      if (essayEntries.length > 0) {
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
      uploads.push(
        await adapter.uploadCoverLetter(page, input.coverLetterPath),
      );
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
  // "essay" is a Greenhouse-form fixture too — used by the human-essay path.
  if (name !== "greenhouse" && name !== "essay") {
    throw new Error(
      `Phase 5 execute/fill fixtures are Greenhouse-only (got "${name}"). Use ats:inspect for other fixtures.`,
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
