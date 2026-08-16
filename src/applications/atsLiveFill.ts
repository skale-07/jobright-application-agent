import type { Db } from "../storage/db/client.js";
import { dismissPageObstructions } from "../browser/obstructions.js";
import {
  authenticateAtsPortal,
  isRecognizedAtsAuthHost,
} from "../verification/portalAuth.js";
import { classifyWorkdayPage } from "../ats/workday/pageKind.js";
import { workdaySelectorsV1 } from "../ats/workday/selectors.js";
import { walkWorkdayWizard } from "./workdayWizard.js";
import { discoverFieldsFromHtml } from "./fieldDiscovery.js";
import path from "node:path";
import fs from "node:fs";
import { getConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { writeJsonAtomic } from "../storage/atomicJson.js";
import { recordFillRun } from "../storage/fillOutcomes.js";
import { redactFillReportForArtifact } from "./fillReportRedaction.js";
import { assertFormFillAllowed, assertSubmitAllowed } from "./formFillGuards.js";
import {
  defaultTtyConfirm,
  type ConfirmSubmission,
} from "./submitConfirmation.js";
import { scanRequiredCompleteness } from "../ats/shared/requiredCompleteness.js";
import { SubmissionUncertainError } from "../ats/shared/submissionUncertain.js";
import { isLoopbackUrl } from "../ats/generic/urlValidation.js";
import { planApplicationFill } from "./applicationFiller.js";
import { postSandboxTrace } from "../sandbox/trace.js";
import { detectAtsFromUrl } from "../ats/shared/urlValidationDispatch.js";
import { ATS_BINDINGS, type AtsBinding } from "./atsBindings.js";
import { findApplicationFrameUrl } from "../ats/shared/frameHop.js";
import { advancePastPosting } from "../ats/shared/postingAdvance.js";
import { classifyPage } from "../ats/shared/pageClassify.js";
import { fetchGreenhouseQuestions } from "../ats/greenhouse/questionsApi.js";
import {
  applyLabelOptions,
  harvestFieldOptions,
  type AnswerSpace,
  type OptionHarvestResult,
} from "../ats/shared/optionHarvest.js";
import {
  fillOtherSpecify,
  type OtherSpecifyOutcome,
} from "../ats/shared/otherSpecify.js";
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
  SubmissionReceipt,
  UploadVerification,
} from "../ats/adapter.js";
import {
  buildOperatorFieldBrief,
  printOperatorFieldBrief,
} from "./operatorFieldBrief.js";
import type { ApprovedFillPlan } from "./approvedFillPlan.js";

async function attemptSandboxSubmit(args: {
  page: Page;
  binding: AtsBinding;
  report: AtsLiveFillReport;
  approvedPlan: ApprovedFillPlan;
  assumeYes?: boolean;
  confirmSubmission?: ConfirmSubmission;
}): Promise<void> {
  const { page, binding, report, approvedPlan } = args;
  const notes: string[] = [];
  const refuse = (
    outcome: NonNullable<AtsLiveFillReport["submit"]>["outcome"],
    reason: string,
  ) => {
    notes.push(reason);
    report.notes.push(reason);
    report.submit = { outcome, clicked: false, receipt: null, notes: [...notes] };
  };

  if (!isLoopbackUrl(report.url) && !isLoopbackUrl(page.url())) {
    refuse(
      "refused",
      "submit refused — ats:fill --submit is sandbox/loopback only; use `submit --application` for an employer",
    );
    return;
  }
  if (!report.verify?.passed || (report.fill?.errors.length ?? 0) > 0) {
    refuse("failed_before_click", "submit withheld — fill verify did not pass");
    return;
  }

  assertSubmitAllowed(`atsLiveFill.${binding.id}.submit`);

  const completeness = await scanRequiredCompleteness(page);
  if (completeness.unanswered.length > 0) {
    const names = completeness.unanswered
      .map((u) => `${u.label} [${u.control}]`)
      .join("; ");
    refuse(
      "failed_before_click",
      `submit withheld — ${completeness.unanswered.length} required question(s) unanswered: ${names}`,
    );
    return;
  }
  notes.push(...completeness.notes);

  const cfg = getConfig();
  if (cfg.submitRequiresLocalConfirmation) {
    const confirm = args.confirmSubmission ?? defaultTtyConfirm();
    const approved = await confirm({
      application_id: "sandbox",
      company: "employer sandbox",
      role: null,
      url: page.url(),
      attempt: 1,
      resume_sha256: "0".repeat(64),
      resume_size_bytes: 0,
      plan: {
        fillable_count: approvedPlan.fillable_count,
        skipped_count: approvedPlan.skipped_count,
        review_required_count: approvedPlan.review_required_count,
      },
    });
    if (!approved) {
      refuse("refused", "submit withheld — operator declined confirmation");
      return;
    }
  } else if (!args.assumeYes) {
    refuse(
      "refused",
      "submit withheld — unattended sandbox submit requires --yes",
    );
    return;
  }

  const attempt = await binding.submit(page);
  notes.push(...attempt.notes);
  report.submit_attempted = attempt.clicked;
  if (!attempt.clicked) {
    report.submit = {
      outcome: "failed_before_click",
      clicked: false,
      receipt: null,
      notes,
    };
    report.notes.push("submit control was not clicked");
    return;
  }

  const screenshotPath = path.join(
    cfg.artifactsDir,
    "ats-submit",
    binding.id,
    `sandbox-receipt-${Date.now()}.png`,
  );
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  try {
    const receipt = await binding.verifySubmission(page, { screenshotPath });
    report.submit = { outcome: "confirmed", clicked: true, receipt, notes };
    report.notes.push(
      `submit confirmed: ${receipt.confirmation_text} (${receipt.confirmation_url})`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const evidence =
      err instanceof SubmissionUncertainError ? err.evidence : undefined;
    report.submit = {
      outcome: "uncertain",
      clicked: true,
      receipt: null,
      notes: [
        ...notes,
        message,
        ...(evidence ? [`evidence: ${JSON.stringify(evidence)}`] : []),
      ],
    };
    report.notes.push(`submit uncertain: ${message}`);
    report.validation_level = "UNVERIFIED";
  }
  await postSandboxTrace(report.url, {
    kind: "submit",
    lines: [
      `submit: ${report.submit?.outcome ?? "unknown"}`,
      ...(report.submit?.notes ?? []).map((n) => `  ${n}`),
    ],
  });
}

function briefPlanEntries(approvedPlan: ApprovedFillPlan) {
  return approvedPlan.entries.map((e) => ({
    field_id: e.field_id,
    label: e.label,
    type: e.type,
    canonical_field: e.canonical_field,
    action:
      e.action === "FILL"
        ? ("fill" as const)
        : e.action === "REVIEW_REQUIRED"
          ? ("review_required" as const)
          : ("skip_empty" as const),
    value: e.value,
    reason: e.reason,
  }));
}

/**
 * Resume for a live fill. `--resume` always wins. On loopback only, a
 * missing flag falls back to DEFAULT_RESUME_PATH when that file exists —
 * so a sandbox run exercises the upload path. A real employer URL never
 * gets a silent attach.
 */
export function resolveLiveFillResumePath(input: {
  url: string;
  explicitResumePath?: string;
  defaultResumePath: string;
  fileExists?: (p: string) => boolean;
}): { path: string; source: "flag" | "sandbox_default" } | null {
  if (input.explicitResumePath) {
    return { path: input.explicitResumePath, source: "flag" };
  }
  if (!isLoopbackUrl(input.url)) return null;
  const exists = input.fileExists ?? ((p) => fs.existsSync(p));
  if (!exists(input.defaultResumePath)) return null;
  return { path: input.defaultResumePath, source: "sandbox_default" };
}

/**
 * Shared guarded live fill for the non-greenhouse ATSes (lever/ashby).
 * Greenhouse keeps its own runGreenhouseLiveFill (full identity
 * verification, healer, essay path); this runner uses the binding's weaker
 * pre-mutation gate — see preMutationGate.ts. Submit is opt-in and
 * loopback-only (`--submit` + SUBMIT_ENABLED): a real employer URL still
 * never clicks Submit here. Use `submit --application` for that.
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
    /** classifyPage result — recovery branches on this, not the collapsed gate code. */
    page_class?: string | null;
  };
  plan_summary: {
    fillable_count: number;
    skipped_count: number;
    review_required_count: number;
  } | null;
  /**
   * Every plan entry's label + routing — values excluded. Exists because a
   * live run once reported "10 skipped" with no way to tell WHICH questions
   * the plan missed; blind counts made the bug undiagnosable. Labels are
   * the form's own question text, not candidate data.
   */
  plan_fields: Array<{
    field_id: string;
    label: string;
    type: string;
    canonical_field: string | null;
    action: string;
    reason: string;
  }> | null;
  /** Sanitized pre-fill page HTML, written when the plan skipped fields. */
  form_snapshot_path: string | null;
  /**
   * The answer space scraped off each live control before planning. This
   * is the evidence that separates "the system chose badly" from "the
   * system never saw the choices" — the distinction the Appian run could
   * not be diagnosed without.
   */
  harvested_options?: Array<{
    field_id: string;
    label: string;
    answer_space: AnswerSpace;
    option_count: number;
    options: string[];
    other_option: string | null;
  }>;
  /** Text boxes revealed by choosing "Other", and what went into them. */
  other_specify?: OtherSpecifyOutcome[];
  fill: FillResult | null;
  verify: FormVerificationResult | null;
  uploads: UploadVerification[] | null;
  validation_level:
    | "LIVE_MUTATION_CONFIRMED"
    | "LIVE_READ_ONLY_CONFIRMED"
    | "UNVERIFIED";
  submit_attempted: boolean;
  submit?: {
    outcome: "confirmed" | "uncertain" | "refused" | "failed_before_click";
    clicked: boolean;
    receipt: SubmissionReceipt | null;
    notes: string[];
  };
  /**
   * Workday only: the wizard pages walked BEYOND the landing page
   * (Next → re-plan → re-fill, bounded; the submit button is never
   * clicked here). Absent for single-page ATSes.
   */
  wizard_pages?: Array<{
    page: number;
    url: string;
    kind: string;
    fillable: number;
    filled: number;
    verify_passed: boolean;
  }>;
  notes: string[];
  report_path?: string;
  /** Built when fill/verify/uploads need operator attention. */
  operator_brief?: import("./operatorFieldBrief.js").OperatorFieldBrief;
};

type BindingGate = {
  ok: boolean;
  html: string;
  finalUrl: string;
  failureCode?: string | null;
  reason?: string | null;
};

function applyGateToReport(
  report: AtsLiveFillReport,
  gate: BindingGate,
): ReturnType<typeof classifyPage> {
  const landing = classifyPage({ html: gate.html, url: gate.finalUrl });
  report.gate = {
    ok: gate.ok,
    failure_code: gate.failureCode ?? null,
    reason: gate.reason ?? null,
    final_url: gate.finalUrl,
    page_class: landing.page_class,
  };
  return landing;
}

const TERMINAL_GATE_CODES = new Set([
  "UNTRUSTED_FINAL_HOST",
  "POSTING_MISMATCH",
  "BLOCKING_CAPTCHA",
  "ATS_MISMATCH",
  "UNSAFE_URL",
]);

export async function runAtsLiveFill(input: {
  binding: AtsBinding;
  url: string;
  execute: boolean;
  profile?: PublicProfile;
  resumePath?: string;
  headless?: boolean;
  /** Forwarded to planApplicationFill: unanswered questions become "Answer needed" review items on this application. */
  capture?: { db: Db; applicationId: string | null };
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
  /**
   * Click Submit after a passing verify. Refused unless the URL is
   * loopback (employer sandbox). Still requires SUBMIT_ENABLED and the
   * same confirmation seam as `submit --application`.
   */
  submit?: boolean;
  /** Honored only when SUBMIT_REQUIRES_LOCAL_CONFIRMATION=false. */
  assumeYes?: boolean;
  confirmSubmission?: ConfirmSubmission;
}): Promise<AtsLiveFillReport> {
  // Mutable: the iframe hop can re-detect a different vendor's adapter for
  // the embedded form (e.g. company page → embedded Greenhouse board).
  let binding = input.binding;
  const report: AtsLiveFillReport = {
    ats: binding.id,
    url: input.url,
    requested_url: input.url,
    mode: "refused",
    gate: { ok: false, failure_code: null, reason: null, final_url: null },
    plan_summary: null,
    plan_fields: null,
    form_snapshot_path: null,
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
      let gate = await binding.gate(page, input.url, detected.normalizedUrl);
      // Iframe hop: a page whose FORM lives in an iframe discovers zero
      // fields (page.content() excludes frames) and fails
      // NO_APPLICATION_FORM. If a child frame's own document carries
      // fillable fields, navigate to the frame's URL — an embedded ATS
      // form is a standalone page — re-detect the adapter (the embed often
      // belongs to a vendor the outer host does not), and re-gate so every
      // pre-mutation check runs on the hopped page.
      if (!gate.ok && gate.failureCode === "NO_APPLICATION_FORM") {
        const frameForm = await findApplicationFrameUrl(page);
        if (frameForm) {
          report.notes.push(
            `application form found in an iframe (${frameForm.fieldCount} fields) — hopping to ${frameForm.url}`,
          );
          await page
            .goto(frameForm.url, { waitUntil: "domcontentloaded" })
            .catch((e: Error) =>
              report.notes.push(`iframe hop navigation failed: ${e.message.slice(0, 120)}`),
            );
          const hopDetected = detectAtsFromUrl(frameForm.url);
          if (hopDetected.ats !== null && hopDetected.ats !== binding.id) {
            report.notes.push(
              `iframe hop: adapter ${binding.id} → ${hopDetected.ats}`,
            );
            binding = ATS_BINDINGS[hopDetected.ats];
            report.ats = binding.id;
          }
          gate = await binding.gate(page, frameForm.url, frameForm.url);
        }
      }
      let landing = applyGateToReport(report, gate);
      report.notes.push(
        `page class at gate: ${landing.page_class} (${landing.evidence})`,
      );
      if (binding.id === "workday") {
        report.notes.push(
          `workday page kind at gate: ${classifyWorkdayPage(gate.html)}`,
        );
      }

      // Host / captcha / mismatch are terminal. Everything else recovers
      // from page_class (auth → portal auth, posting → Apply, unknown →
      // park), not from the gate's collapsed NO_APPLICATION_FORM.
      if (!gate.ok && TERMINAL_GATE_CODES.has(gate.failureCode ?? "")) {
        report.notes.push("refused before any mutation — page gate failed");
        return persist(report);
      }

      let planHtml = gate.html;
      let planUrl = gate.finalUrl;

      if (input.execute) {
        const obstructions = await dismissPageObstructions(page);
        if (obstructions.dismissed.length > 0) {
          report.notes.push(
            `popups dismissed: ${obstructions.dismissed.join(", ")}`,
          );
        }

        const canAuth = () =>
          getConfig().navigationEnabled &&
          isRecognizedAtsAuthHost(page.url());

        // Workday's Apply → Apply Manually walk lives in portalAuth.
        // Generic posting advance would click Apply and land on the
        // chooser, which classifyPage cannot name — do not steal that.
        const workdayOwnsWalk = binding.id === "workday" && canAuth();

        if (!workdayOwnsWalk && landing.page_class === "posting") {
          const advance = await advancePastPosting({
            page,
            html: planHtml,
            url: planUrl,
          });
          report.notes.push(...advance.notes);
          if (advance.hops > 0) {
            page = advance.page;
            planHtml = advance.html;
            planUrl = advance.url;
            gate = await binding.gate(page, advance.url, advance.url);
            landing = applyGateToReport(report, gate);
          }
          if (landing.page_class === "posting") {
            report.gate.ok = false;
            report.gate.failure_code = "FORM_NOT_REACHED";
            report.gate.reason =
              "still on the job posting after trying Apply — no application form to fill";
            report.gate.page_class = "posting";
            report.notes.push(
              "parked: refused to fill a listing page's own search widgets",
            );
            return persist(report);
          }
        }

        const tryPortalAuth =
          canAuth() &&
          (workdayOwnsWalk || landing.page_class === "auth");

        if (tryPortalAuth) {
          // portalAuth keeps secrets OUT of its notes by construction, and
          // the form snapshot scrubs every value= attribute — so the
          // password/code never reach the artifact. auth.secrets is the
          // scrub list for any future value-based redaction.
          const auth = await authenticateAtsPortal(page);
          void auth.secrets;
          report.notes.push(...auth.notes);
          const cleared =
            auth.status === "signed_in" ||
            auth.status === "account_created" ||
            (binding.id === "workday" && auth.status === "not_an_auth_wall");
          if (!cleared) {
            report.gate.ok = false;
            report.gate.failure_code = "AUTH_REQUIRED";
            report.gate.reason = `portal auth did not clear the wall (${auth.status})`;
            report.gate.page_class = "auth";
            report.notes.push("parked: account wall not cleared");
            return persist(report);
          }
          // Gate HTML is the posting/login we arrived on. Plan AFTER
          // sign-in. Do not treat POSTING_MISMATCH as fatal — apply URL
          // paths often diverge from the normalized posting.
          planHtml = await page.content();
          planUrl = page.url();
          if (binding.id === "workday") {
            const kind = classifyWorkdayPage(planHtml);
            report.notes.push(`workday page kind after auth: ${kind}`);
            if (kind === "posting" || kind === "chooser") {
              report.gate.ok = false;
              report.gate.failure_code = "FORM_NOT_REACHED";
              report.gate.reason = `still on Workday ${kind} after portal auth`;
              report.notes.push(
                "parked: Apply / Apply Manually did not reach the application form",
              );
              return persist(report);
            }
            if (kind === "auth") {
              report.gate.ok = false;
              report.gate.failure_code = "AUTH_REQUIRED";
              report.gate.reason = "still on Workday sign-in after portal auth";
              report.gate.page_class = "auth";
              report.notes.push("parked: Workday account wall not cleared");
              return persist(report);
            }
            // wizard | unknown: the page claims to BE the form, so it has
            // to have fields. This branch skips binding.gate entirely
            // (the apply path legitimately leaves the posting URL), so it
            // is also the one place the shared gate's zero-field refusal
            // cannot reach. Crowe live: 0 planned, 0 filled, verify
            // failed — a refusal names that, a 0-field fill hides it.
            if (discoverFieldsFromHtml(planHtml).length === 0) {
              report.gate.ok = false;
              report.gate.failure_code = "NO_APPLICATION_FORM";
              report.gate.reason = `Workday page classified ${kind} but has no fillable fields`;
              report.notes.push(
                "parked: reached a Workday page with nothing to fill",
              );
              return persist(report);
            }
            landing = classifyPage({ html: planHtml, url: planUrl });
            report.gate.ok = true;
            report.gate.failure_code = null;
            report.gate.reason = null;
            report.gate.final_url = planUrl;
            report.gate.page_class = landing.page_class;
          } else {
            const again = await binding.gate(
              page,
              input.url,
              detected.normalizedUrl,
            );
            if (again.ok) {
              planHtml = again.html;
              planUrl = again.finalUrl;
              landing = applyGateToReport(report, again);
            } else if (again.failureCode === "POSTING_MISMATCH") {
              report.notes.push(
                "post-auth path differs from posting URL — planning the landed page",
              );
              landing = classifyPage({ html: planHtml, url: planUrl });
              report.gate = {
                ok: true,
                failure_code: null,
                reason: null,
                final_url: planUrl,
                page_class: landing.page_class,
              };
            } else {
              landing = applyGateToReport(report, again);
              report.gate.ok = false;
              report.gate.failure_code = again.failureCode ?? "AUTH_REQUIRED";
              report.gate.reason = again.reason ?? "page gate still failed after portal auth";
              report.notes.push("refused after portal auth — page gate still failed");
              return persist(report);
            }
          }
        }
      }

      landing = classifyPage({ html: planHtml, url: planUrl });
      report.gate.page_class = landing.page_class;

      if (!report.gate.ok && landing.page_class !== "form") {
        if (landing.page_class === "auth") {
          report.gate.failure_code = report.gate.failure_code ?? "LOGIN_WALL";
          report.notes.push(
            "refused — login wall; set NAVIGATION_ENABLED=true and PORTAL_LOGIN_EMAIL/PASSWORD to sign in",
          );
        } else if (landing.page_class === "posting") {
          report.gate.failure_code = input.execute
            ? "FORM_NOT_REACHED"
            : "NO_APPLICATION_FORM";
          report.notes.push("refused before any mutation — page is a posting, not a form");
        } else if (landing.page_class === "unknown") {
          report.gate.failure_code = "UNKNOWN_LANDING";
          report.gate.reason = landing.evidence;
          report.notes.push(
            `parked: page class unknown (${landing.evidence}) — not a form, posting, or login wall`,
          );
        } else if (landing.page_class === "confirmation") {
          report.gate.failure_code = "ALREADY_CONFIRMED";
          report.notes.push("refused — page already shows an application confirmation");
        } else {
          report.notes.push("refused before any mutation — page gate failed");
        }
        return persist(report);
      }

      // Scrape each control's REAL answer space before planning anything.
      // HTML cannot see a React-select's option list, so without this every
      // dropdown reaches the planner empty and the tiers below degrade to
      // typing blind (live Appian: "Summer Atlantic Capital" typed into a
      // list that only offered "Other"). Execute-only — plan_only stays
      // zero-interaction — and read-only w.r.t. values: it opens controls,
      // reads, and escapes without ever committing a choice.
      let harvest: OptionHarvestResult | null = null;
      if (input.execute) {
        let planFields = discoverFieldsFromHtml(planHtml);
        // Greenhouse publishes the form's questions and their COMPLETE
        // option lists as public JSON. One request beats opening eight
        // comboboxes, and it cannot be truncated by a virtualized menu's
        // scroll position the way a DOM read can (live: "How did you hear
        // about Appian?" has 22 options). Fail-open — null means the DOM
        // harvest below carries the whole load, exactly as before.
        const declared = await fetchGreenhouseQuestions(planUrl).catch(() => null);
        const apiOptions = new Map<string, string[]>();
        if (declared) {
          const applied = applyLabelOptions(planFields, declared.byLabel);
          planFields = applied.fields;
          for (const f of planFields) {
            if ((f.options?.length ?? 0) > 0) apiOptions.set(f.id, f.options!);
          }
          report.notes.push(
            `board API declared ${declared.questions.length} question(s); matched complete option lists onto ${applied.matched} field(s)`,
          );
        }
        // Fields the API already answered are not re-opened in the browser —
        // that is the speed win. The harvest handles only what is left.
        harvest = await harvestFieldOptions(page, planFields);
        for (const [id, options] of apiOptions) {
          harvest.options.set(id, options);
          harvest.answerSpace.set(id, "closed");
        }
        report.notes.push(...harvest.notes);
        report.harvested_options = harvest.harvested.map((h) => ({
          field_id: h.field_id,
          label: h.label,
          answer_space: h.answer_space,
          option_count: h.options.length,
          options: h.options.slice(0, 25),
          other_option: h.other_option,
        }));
        await postSandboxTrace(input.url, {
          kind: "harvest",
          lines: harvest.harvested.map(
            (h) =>
              `${h.label.slice(0, 60)}: ${h.answer_space} (${h.options.length} options)${
                h.other_option ? ` other="${h.other_option}"` : ""
              }`,
          ),
        });
      }
      const { adapter, plan, approvedPlan, fields: plannedFields, otherFallbacks } =
        await planApplicationFill({
          url: planUrl,
          html: planHtml,
          ...(input.profile ? { profile: input.profile } : {}),
          ...(input.capture ? { capture: input.capture } : {}),
          ...(harvest ? { liveOptions: harvest.options } : {}),
          ...(harvest ? { answerSpace: harvest.answerSpace } : {}),
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
      report.plan_fields = approvedPlan.entries.map((e) => ({
        field_id: e.field_id,
        label: e.label,
        type: String(e.type),
        canonical_field: e.canonical_field ?? null,
        action: String(e.action),
        reason: e.reason,
      }));
      await postSandboxTrace(input.url, {
        kind: "plan",
        lines: [
          `${approvedPlan.fillable_count} fill / ${approvedPlan.skipped_count} skip / ${approvedPlan.review_required_count} review`,
          ...approvedPlan.entries.map((e) => {
            const val =
              e.value === undefined || e.value === null
                ? ""
                : ` → ${String(e.value).slice(0, 70)}`;
            return `${String(e.action).padEnd(16)} ${e.label.slice(0, 48)}${val}  [${e.reason}]`;
          }),
        ],
      });
      // Ground truth for skipped-question diagnosis: the pre-fill DOM, with
      // control values scrubbed (a handoff page can arrive pre-filled).
      if (approvedPlan.skipped_count > 0 && planHtml) {
        report.form_snapshot_path = writeFormSnapshot(planHtml);
      }

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
      const knownFieldIds = new Set(plannedFields.map((f) => f.id));
      report.fill = await adapter.fill(page, approvedPlan.answers);
      // Choosing "Other" usually reveals an "Other (please specify)" box —
      // an OPEN answer space that only exists after the option commits.
      // The real answer the closed list could not hold goes in there.
      if (otherFallbacks.length > 0) {
        const specified = await fillOtherSpecify({
          page,
          knownFieldIds,
          requests: otherFallbacks.map((o) => ({
            field_id: o.field_id,
            label: o.label,
            intended: o.intended,
          })),
        });
        report.other_specify = specified;
        report.notes.push(...specified.map((s) => `other-specify: ${s.note}`));
      }
      report.verify = await adapter.verify(page, approvedPlan.answers);
      await postSandboxTrace(input.url, {
        kind: "fill",
        lines: [
          `filled: ${(report.fill.filled ?? []).join(", ") || "(none)"}`,
          ...(report.fill.errors ?? []).map((e) => `ERROR ${e}`),
          `verify: ${report.verify.passed ? "passed" : "failed"}`,
          ...(report.other_specify ?? []).map((s) => `other-specify: ${s.note}`),
        ],
      });
      // Uploads after field mutation is settled, matching the greenhouse order.
      if (input.resumePath) {
        report.uploads = [await adapter.uploadResume(page, input.resumePath)];
      }

      // Workday is a MULTI-PAGE wizard (Crowe live: 7 steps). Filling only
      // the landing page left My Experience / Application Questions /
      // Voluntary Disclosures untouched — the app then died at submit on
      // "required questions unanswered" that were never even seen. The
      // walk (workdayWizard.ts) clicks Next → settles → hands each page to
      // this filler; bounded, and NEVER the submit button.
      let wizardVerifyFailed = false;
      if (binding.id === "workday") {
        const walk = await walkWorkdayWizard(page, async ({ html, url }) => {
          const pagePlan = await planApplicationFill({
            url,
            html,
            ...(input.profile ? { profile: input.profile } : {}),
            ...(input.capture ? { capture: input.capture } : {}),
          });
          const wizardAdapter = pagePlan.adapter;
          const fillResult = await wizardAdapter.fill(page, pagePlan.approvedPlan.answers);
          const verifyResult = await wizardAdapter.verify(page, pagePlan.approvedPlan.answers);
          // Resume upload lives on My Experience — retry there if page 1
          // had no control (or its upload failed to verify).
          if (
            input.resumePath &&
            !(report.uploads?.some((u) => u.verified) ?? false) &&
            (await page
              .locator(workdaySelectorsV1.wizard.resumeUpload)
              .first()
              .count()
              .catch(() => 0)) > 0
          ) {
            const upload = await wizardAdapter.uploadResume(page, input.resumePath);
            report.uploads = [...(report.uploads ?? []), upload];
          }
          if (pagePlan.approvedPlan.skipped_count > 0) {
            report.form_snapshot_path = writeFormSnapshot(html);
          }
          return {
            fillable: pagePlan.approvedPlan.fillable_count,
            filled: fillResult.filled.length,
            verifyPassed: verifyResult.passed && fillResult.errors.length === 0,
          };
        }, {
          applicationId: input.capture?.applicationId ?? null,
          // Mid-walk session expiry: sign back in (same gates as
          // tryPortalAuth) and resume, instead of abandoning a wizard
          // that is already half filled.
          onAuthWall: async (walkPage) => {
            if (!getConfig().navigationEnabled) return false;
            if (!isRecognizedAtsAuthHost(walkPage.url())) return false;
            const auth = await authenticateAtsPortal(walkPage);
            report.notes.push(...auth.notes);
            return auth.status === "signed_in" || auth.status === "account_created";
          },
        });
        report.wizard_pages = walk.pages;
        report.notes.push(...walk.notes);
        wizardVerifyFailed = walk.verifyFailed;
      }

      report.validation_level =
        report.verify.passed &&
        report.fill.errors.length === 0 &&
        !wizardVerifyFailed &&
        (report.uploads?.every((u) => u.verified) ?? true)
          ? "LIVE_MUTATION_CONFIRMED"
          : "UNVERIFIED";
      if (input.submit) {
        await attemptSandboxSubmit({
          page,
          binding,
          report,
          approvedPlan,
          ...(input.assumeYes ? { assumeYes: true } : {}),
          ...(input.confirmSubmission
            ? { confirmSubmission: input.confirmSubmission }
            : {}),
        });
      } else {
        report.notes.push("submit not attempted — live fill never submits");
      }
      if (report.validation_level === "UNVERIFIED") {
        const brief = buildOperatorFieldBrief({
          context: `Live fill — ${binding.id} ${gate.finalUrl}`,
          verify: report.verify,
          fill: report.fill,
          upload: report.uploads?.find((u) => !u.verified) ?? null,
          planEntries: briefPlanEntries(approvedPlan),
        });
        report.operator_brief = brief;
        printOperatorFieldBrief(brief);
      }
      return persist(report, { plan, approvedPlan });
    },
  );

  /**
   * Persist a value-scrubbed copy of the page HTML for offline discovery
   * repro. Scrubbing is defensive: value attributes, textarea bodies, and
   * scripts go; question labels and structure — the diagnostic payload —
   * stay. Capped so a pathological page can't flood the artifacts dir.
   */
  function writeFormSnapshot(html: string): string {
    const cfg = getConfig();
    const outDir = path.join(cfg.artifactsDir, "ats-fill", `${binding.id}-live`);
    fs.mkdirSync(outDir, { recursive: true });
    const snapshotPath = path.join(outDir, `form-snapshot-${Date.now()}.html`);
    const scrubbed = html
      .replace(/<script\b[\s\S]*?<\/script>/gi, "")
      .replace(/\bvalue\s*=\s*"[^"]*"/gi, 'value="[SCRUBBED]"')
      .replace(/\bvalue\s*=\s*'[^']*'/gi, "value='[SCRUBBED]'")
      .replace(
        /(<textarea\b[^>]*>)[\s\S]*?(<\/textarea>)/gi,
        "$1[SCRUBBED]$2",
      )
      .slice(0, 2_000_000);
    fs.writeFileSync(snapshotPath, scrubbed, "utf8");
    return snapshotPath;
  }

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
