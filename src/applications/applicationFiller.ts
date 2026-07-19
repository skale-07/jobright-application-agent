import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config/index.js";
import { writeJsonAtomic } from "../storage/atomicJson.js";
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

export type ApplicationFillReport = {
  mode: "plan_only" | "executed";
  ats: string;
  url: string;
  plan: ReturnType<typeof buildFillPlan>;
  approved_plan?: ReturnType<typeof toApprovedFillPlan>;
  fill?: Awaited<ReturnType<GreenhouseAdapterV1["fill"]>>;
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
}): Promise<ApplicationFillReport> {
  const notes: string[] = [];
  const { adapter, plan, approvedPlan } = await planApplicationFill(input);

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
  },
): Promise<ApplicationFillReport> {
  if (name !== "greenhouse") {
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
  const redacted = redactFillReportForArtifact({
    ...report,
    written_at: new Date().toISOString(),
  });
  writeJsonAtomic(reportPath, redacted);
  return { ...report, report_path: reportPath };
}
