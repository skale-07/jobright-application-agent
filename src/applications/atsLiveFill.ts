import path from "node:path";
import fs from "node:fs";
import { getConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { writeJsonAtomic } from "../storage/atomicJson.js";
import { recordFillRun } from "../storage/fillOutcomes.js";
import { redactFillReportForArtifact } from "./fillReportRedaction.js";
import { assertFormFillAllowed } from "./formFillGuards.js";
import { planApplicationFill } from "./applicationFiller.js";
import { detectAtsFromUrl } from "../ats/shared/urlValidationDispatch.js";
import type { AtsBinding } from "./atsBindings.js";
import {
  withFixtureHtmlPage,
  withPublicUrlPage,
} from "../browser/fixtureSession.js";
import type { Page } from "playwright";
import { verifyResumePdfFile } from "../jobright/resumeDownload.js";
import type { PublicProfile } from "../candidate/publicProfile.js";
import type {
  FillResult,
  FormVerificationResult,
  UploadVerification,
} from "../ats/adapter.js";

/**
 * Shared guarded live fill for the non-greenhouse ATSes (lever/ashby).
 * Greenhouse keeps its own runGreenhouseLiveFill (full identity
 * verification, healer, essay path); this runner uses the binding's weaker
 * pre-mutation gate — see preMutationGate.ts — and NEVER submits.
 *
 * Validation-ladder honesty: plan_only runs are LIVE_READ_ONLY_CONFIRMED at
 * most; executed runs are LIVE_MUTATION_CONFIRMED only when the read-back
 * verify passed, else UNVERIFIED. Nothing here promotes a synthetic-fixture
 * claim — a green run against a real page IS the live evidence.
 */
export type AtsLiveFillReport = {
  ats: string;
  url: string;
  requested_url: string;
  mode: "refused" | "plan_only" | "executed";
  gate: {
    ok: boolean;
    failure_code: string | null;
    reason: string | null;
    final_url: string | null;
  };
  plan_summary: {
    fillable_count: number;
    skipped_count: number;
    review_required_count: number;
  } | null;
  fill: FillResult | null;
  verify: FormVerificationResult | null;
  uploads: UploadVerification[] | null;
  validation_level:
    | "LIVE_MUTATION_CONFIRMED"
    | "LIVE_READ_ONLY_CONFIRMED"
    | "UNVERIFIED";
  submit_attempted: false;
  notes: string[];
  report_path?: string;
};

export async function runAtsLiveFill(input: {
  binding: AtsBinding;
  url: string;
  execute: boolean;
  profile?: PublicProfile;
  resumePath?: string;
  headless?: boolean;
  /**
   * Test seam (liveInspect precedent): serve this HTML at the normalized
   * URL instead of navigating the network. Any resulting validation level
   * is demoted — a fixture-served page is never live evidence.
   */
  fixtureHtml?: string;
  /**
   * Session handoff (nav N6): run on this page — typically a CDP-attached
   * page whose cookies survive from navigation. The caller owns its
   * lifetime; this runner navigates it but never closes it.
   */
  existingPage?: Page;
}): Promise<AtsLiveFillReport> {
  const { binding } = input;
  const report: AtsLiveFillReport = {
    ats: binding.id,
    url: input.url,
    requested_url: input.url,
    mode: "refused",
    gate: { ok: false, failure_code: null, reason: null, final_url: null },
    plan_summary: null,
    fill: null,
    verify: null,
    uploads: null,
    validation_level: "UNVERIFIED",
    submit_attempted: false,
    notes: [],
  };

  const detected = detectAtsFromUrl(input.url);
  if (detected.ats === null) {
    report.gate.reason = detected.failureReason;
    report.gate.failure_code = "UNSAFE_URL";
    return persist(report);
  }
  if (detected.ats !== binding.id) {
    report.gate.failure_code = "ATS_MISMATCH";
    report.gate.reason = `URL validated as ${detected.ats}, binding is ${binding.id}`;
    return persist(report);
  }
  report.url = detected.normalizedUrl;

  if (input.resumePath) {
    const preflight = verifyResumePdfFile(input.resumePath);
    if (!preflight.verified) {
      report.gate.failure_code = "RESUME_PREFLIGHT_FAILED";
      report.gate.reason = `resume preflight failed: ${preflight.evidence}`;
      return persist(report);
    }
  }

  const runInPage = async (
    fn: (page: Page) => Promise<AtsLiveFillReport>,
  ): Promise<AtsLiveFillReport> => {
    if (input.existingPage) {
      const page = input.existingPage;
      report.notes.push("session: handoff (caller-owned page, not closed here)");
      await page.goto(detected.normalizedUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      return fn(page);
    }
    if (input.fixtureHtml !== undefined) {
      const html = input.fixtureHtml;
      return withFixtureHtmlPage("<html><body></body></html>", async (page) => {
        await page.route("**/*", (route) =>
          route.fulfill({ body: html, contentType: "text/html" }),
        );
        await page.goto(detected.normalizedUrl, {
          waitUntil: "domcontentloaded",
        });
        return fn(page);
      });
    }
    return withPublicUrlPage(detected.normalizedUrl, fn, {
      headless: input.headless ?? true,
    });
  };

  // Read-only page fetch is allowed without flags; mutation asserts below.
  return runInPage(
    async (page) => {
      const gate = await binding.gate(page, input.url, detected.normalizedUrl);
      report.gate = {
        ok: gate.ok,
        failure_code: gate.failureCode ?? null,
        reason: gate.reason ?? null,
        final_url: gate.finalUrl,
      };
      if (!gate.ok) {
        report.notes.push("refused before any mutation — page gate failed");
        return persist(report);
      }

      const { adapter, plan, approvedPlan } = await planApplicationFill({
        url: gate.finalUrl,
        html: gate.html,
        ...(input.profile ? { profile: input.profile } : {}),
      });
      if (adapter.id !== binding.id) {
        report.gate.failure_code = "ATS_MISMATCH";
        report.gate.reason = `page detected as ${adapter.id}, binding is ${binding.id}`;
        report.notes.push("refused before any mutation — adapter mismatch");
        return persist(report);
      }
      report.plan_summary = {
        fillable_count: approvedPlan.fillable_count,
        skipped_count: approvedPlan.skipped_count,
        review_required_count: approvedPlan.review_required_count,
      };

      if (!input.execute) {
        report.mode = "plan_only";
        report.validation_level = "LIVE_READ_ONLY_CONFIRMED";
        report.notes.push(
          "plan_only — set --execute with FORM_FILL_ENABLED=true and DRY_RUN=false to mutate",
        );
        return persist(report, { plan, approvedPlan });
      }

      assertFormFillAllowed(`atsLiveFill.${binding.id}.execute`);
      report.mode = "executed";
      report.fill = await adapter.fill(page, approvedPlan.answers);
      report.verify = await adapter.verify(page, approvedPlan.answers);
      // Uploads after field mutation is settled, matching the greenhouse order.
      if (input.resumePath) {
        report.uploads = [await adapter.uploadResume(page, input.resumePath)];
      }
      report.validation_level =
        report.verify.passed &&
        report.fill.errors.length === 0 &&
        (report.uploads?.every((u) => u.verified) ?? true)
          ? "LIVE_MUTATION_CONFIRMED"
          : "UNVERIFIED";
      report.notes.push("submit not attempted — live fill never submits");
      return persist(report, { plan, approvedPlan });
    },
  );

  function persist(
    r: AtsLiveFillReport,
    plans?: {
      plan: Awaited<ReturnType<typeof planApplicationFill>>["plan"];
      approvedPlan: Awaited<ReturnType<typeof planApplicationFill>>["approvedPlan"];
    },
  ): AtsLiveFillReport {
    if (input.fixtureHtml !== undefined && r.validation_level !== "UNVERIFIED") {
      r.validation_level = "UNVERIFIED";
      r.notes.push(
        "fixture-served page (test seam) — validation level demoted, not live evidence",
      );
    }
    const cfg = getConfig();
    const outDir = path.join(cfg.artifactsDir, "ats-fill", `${r.ats}-live`);
    fs.mkdirSync(outDir, { recursive: true });
    const reportPath = path.join(outDir, `live-${r.mode}-${Date.now()}.json`);

    if (r.mode === "executed" && plans) {
      recordFillRun({
        mode: "executed",
        source: "cli_url",
        ats: r.ats,
        job_url: r.url,
        mutation_attempted: true,
        validation_level: r.validation_level,
        fillable_count: plans.approvedPlan.fillable_count,
        skipped_count: plans.approvedPlan.skipped_count,
        report_artifact_relpath: path.relative(cfg.artifactsDir, reportPath),
        notes: r.notes,
        plan_entries: plans.approvedPlan.entries.map((e) => ({
          field_id: e.field_id,
          label: e.label,
          type: e.type as string,
          canonical_field: e.canonical_field ?? null,
          action: String(e.action),
          value: e.value,
          reason: e.reason,
          approved: e.approved,
        })),
        fill: r.fill,
        verify: r.verify,
        uploads: r.uploads,
        heal: null,
      });
    }

    const redacted = redactFillReportForArtifact({
      ...r,
      written_at: new Date().toISOString(),
    } as unknown as Record<string, unknown>);
    writeJsonAtomic(reportPath, redacted);
    r.report_path = reportPath;
    logger.info("ats live fill finished", {
      service: r.ats,
      action: "live_fill",
      metadata: {
        mode: r.mode,
        gate_ok: r.gate.ok,
        validation_level: r.validation_level,
      },
    });
    return r;
  }
}
