import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import type { Db } from "../storage/db/client.js";
import { getConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { writeJsonAtomic } from "../storage/atomicJson.js";
import { redactObject } from "../logging/redaction.js";
import { PlaywrightServiceSession } from "../auth/serviceSession.js";
import { detectAuthLossOnPage } from "../auth/authLossDetect.js";
import { handleAuthExpiry } from "../auth/authExpiry.js";
import { detectLoginWall } from "../ats/greenhouse/loginWallDetection.js";
import { detectBlockingCaptcha } from "../ats/greenhouse/captchaDetection.js";
import { discoverFieldsFromHtml } from "../applications/fieldDiscovery.js";
import { getStoredJobInspectionTargetByApplicationId } from "../jobright/storedJobTarget.js";
import {
  clickApplyAndCaptureExternalUrl,
  clearJobRightInterstitial,
  detectClosedJobBanner,
  readExternalApplyHrefs,
} from "../jobright/navigateToEmployer.js";
import { navigateViaSidecar } from "../agent/navigate.js";
import type {
  AgentNavigateResult,
  AgentNavigateTask,
} from "../agent/contract.js";
import type { VerificationWaitResult } from "../gmail/waitForVerification.js";
import {
  emailVerificationAvailable,
  resolveNavVerificationWaiter,
} from "../verification/emailVerification.js";
import { prepareCredentialsForHost } from "../verification/accountCredentials.js";
import {
  diagnoseLoginWall,
  summarizeLoginWall,
  type LoginWallDiagnosis,
} from "../verification/loginWallDiagnosis.js";
import { dismissPageObstructions } from "../browser/obstructions.js";
import { assertNavigationAllowed } from "./navigationGuards.js";
import { storeResolvedEmployerUrl } from "./storeResult.js";
import { detectAtsFromUrl } from "../ats/shared/urlValidationDispatch.js";
import { recordNavigationAttempt } from "../storage/navSubmitOutcomes.js";
import { codeVersion } from "../storage/codeVersion.js";
import { evaluateAgentHostPolicy } from "./hostPolicy.js";
import {
  employerSiblingHosts,
  explainAtsAnchorMisses,
  looksLikeApplicationUrl,
  selectCandidateApplyLinks,
  traversalHosts,
} from "./candidateLinks.js";
import {
  checkUrlCongruence,
  findApplicationsWithEmployerUrl,
  getJobIdentity,
  type CongruenceVerdict,
} from "./congruence.js";


/**
 * Why the agent phase can or cannot run, as one named cause. The 4a7c199b
 * session showed 7/7 apps dying behind "AGENT_FALLBACK_ENABLED off or CDP
 * Chrome unreachable" — a message that names two causes is evidence for
 * neither, and the operator fix differs (set the flag vs start the debug
 * Chrome).
 */
export async function resolveAgentAvailability(input: {
  override: boolean | undefined;
  flagEnabled: boolean;
  cdpUrl: string;
  probe?: (cdpUrl: string) => Promise<boolean>;
}): Promise<{ possible: boolean; reason: string | null }> {
  if (input.override !== undefined) {
    return {
      possible: input.override,
      reason: input.override ? null : "agent phase disabled for this run",
    };
  }
  if (!input.flagEnabled) {
    return { possible: false, reason: "AGENT_FALLBACK_ENABLED is off" };
  }
  if (!(await (input.probe ?? probeCdpEndpoint)(input.cdpUrl))) {
    return {
      possible: false,
      reason: `CDP Chrome unreachable at ${input.cdpUrl}`,
    };
  }
  return { possible: true, reason: null };
}

/**
 * Does the agent's page evidence actually show a verification prompt?
 * Matches the vocabulary sites use when they HAVE sent a mail ("verify
 * your email", "we sent a code", "check your inbox", "confirmation link").
 */
export function verificationEvidencePresent(evidence: string | undefined): boolean {
  if (!evidence || evidence.trim().length === 0) return false;
  return /verif(y|ied|ication)|we('ve| have)? (sent|emailed)|sent (you )?(a|an|the) (code|link|email)|check your (email|inbox|mail)|confirmation (code|link|email)|enter the code|one[- ]time (code|passcode)|security code/i.test(
    evidence,
  );
}

/** Bounded reachability probe for the operator's CDP Chrome. */
export async function probeCdpEndpoint(cdpUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    const res = await fetch(new URL("/json/version", cdpUrl), {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

export type NavigationWall =
  | "none"
  | "jobright_auth"
  | "auth"
  | "captcha"
  | "phone_otp"
  | "budget"
  /**
   * The deterministic phases did not resolve and the agent phase could not
   * run at all (no reachable CDP Chrome / fallback disabled). Distinct from
   * "budget": nothing was spent and nothing was tried — it is an operator
   * configuration gap, not an exhausted attempt.
   */
  | "agent_unavailable"
  | "submit_risk"
  /** JobRight says the posting is closed — no Apply path exists. */
  | "closed"
  /**
   * Resolved URL belongs to a different employer than the job record.
   * NO LONGER PRODUCED by a navigation run (operator directive
   * 2026-08-14: congruence is evidence, not a gate). Kept because stored
   * reports carry it and `auditEmployerUrls` — the offline sweep that
   * repairs a URL a human is about to submit against — still parks on it.
   */
  | "mismatch"
  /** Another live application already holds this employer URL. */
  | "duplicate_url";

export type NavigationMethod =
  | "anchor_href"
  | "apply_click_popup"
  | "apply_click_same_tab"
  /** Deterministic sign-in / create-account cleared an employer login wall. */
  | "portal_auth"
  | "agent"
  | null;

export type NavigationPhaseTrace = {
  phase: string;
  outcome: string;
  evidence?: string;
};

export type NavigationReport = {
  run_id: string;
  application_id: string;
  jobright_job_id: string | null;
  method: NavigationMethod;
  resolved_url: string | null;
  resolved_ats: string | null;
  wall: NavigationWall;
  phase_trace: NavigationPhaseTrace[];
  agent: { turns_used: number; steps_used: number; domains_visited: string[] } | null;
  gmail: { polls_used: number; matched_message_id: string | null } | null;
  /** Present when the agent paused on an email-verification wall. */
  need: AgentNavigateResult["need"] | null;
  session: "cdp" | "ephemeral";
  notes: string[];
  /** Identity check between the job's company and any candidate URL. */
  congruence: (CongruenceVerdict & { expected_company: string; url: string }) | null;
  /** Populated on wall "duplicate_url": who already holds this URL. */
  duplicates: Array<{ application_id: string; state: string; company: string; role: string }> | null;
  /**
   * Zero-mutation read of an employer login wall's shape, whenever one was
   * hit (operator request 2026-08-12). Present even when nothing was
   * attempted — the point is to make a parked auth wall explainable from
   * the artifact alone instead of from a screenshot.
   */
  login_wall: LoginWallDiagnosis | null;
  report_path?: string;
};

/** Test seam: a minimal session shape runNavigation actually uses. */
export type NavSession = {
  open(): Promise<void>;
  newPage(options?: { purpose?: string }): Promise<Page>;
  getContext(): ReturnType<PlaywrightServiceSession["getContext"]>;
  close(): Promise<void>;
};

export type RunNavigationInput = {
  db: Db;
  applicationId: string;
  headless?: boolean;
  /** Test seam: replaces the JobRight ServiceSession. */
  sessionOverride?: NavSession;
  /**
   * The sessionOverride belongs to the caller and outlives this run: the
   * run closes only the PAGE it opened, never the session. The L3 worker
   * passes one shared session across the whole loop — opening a fresh
   * browser per app cost ~4–6s each (run 8bcff01c).
   */
  callerOwnedSession?: boolean;
  /** Test seam: replaces the JobRight page URL goto target check. */
  skipAuthLossCheck?: boolean;
  /** Test seam: fake sidecar for the agent phase. */
  agentCommandOverride?: { command: string; args: string[] };
  /** Test seam: force the agent-phase availability decision. */
  agentPhaseOverride?: boolean;
  /** Test seam: fake Gmail verification waiter. */
  gmailWaiterOverride?: (
    need: NonNullable<AgentNavigateResult["need"]>,
    allowedDomains: string[],
  ) => Promise<VerificationWaitResult>;
};

const TOTAL_WALLCLOCK_MS = 8 * 60_000;

/**
 * Resolve a usable employer application URL for one application, starting
 * from its JobRight job page. Deterministic phases only in N2:
 *   A) read external apply anchor hrefs (zero mutation);
 *   B) click standard Apply and capture the popup/same-tab URL (guarded by
 *      NAVIGATION_ENABLED — this mutates JobRight applied-state).
 * The agent (N3) and Gmail (N4) phases extend this runner. Navigation
 * never answers form fields and never clicks an application submit.
 */
export async function runNavigation(
  input: RunNavigationInput,
): Promise<NavigationReport> {
  assertNavigationAllowed("runNavigation");
  const { db, applicationId } = input;
  const startedAt = Date.now();
  const deadline = startedAt + TOTAL_WALLCLOCK_MS;

  const report: NavigationReport = {
    run_id: `nav-${randomUUID()}`,
    application_id: applicationId,
    jobright_job_id: null,
    method: null,
    resolved_url: null,
    resolved_ats: null,
    wall: "none",
    phase_trace: [],
    agent: null,
    gmail: null,
    need: null,
    session: "ephemeral",
    notes: [],
    congruence: null,
    duplicates: null,
    login_wall: null,
  };

  /** Values that must never reach the artifact, whatever echoes them. */
  const secretValues: string[] = [];

  /**
   * Streaming phase markers: every phase_trace entry ALSO logs the moment
   * it happens, so the console run log shows live progress instead of
   * multi-minute silence followed by end-of-run archaeology. Progress is
   * telemetry, never a result — outcomes still come from the return path.
   */
  const trace = (entry: NavigationPhaseTrace): void => {
    report.phase_trace.push(entry);
    logger.info(`nav phase: ${entry.phase}`, {
      service: "navigation",
      action: "nav_phase",
      metadata: {
        run_id: report.run_id,
        application_id: applicationId,
        phase: entry.phase,
        outcome: entry.outcome,
        ...(entry.evidence ? { evidence: entry.evidence } : {}),
      },
    });
  };

  /**
   * Sidecar step/heartbeat stream, kept for the per-run trace artifact
   * (training corpus: scrubbed action + host + timing per step) and
   * re-logged live. Secrets are scrubbed the same way the artifact is.
   */
  const agentEvents: Array<Record<string, unknown>> = [];
  const onAgentProgress = (event: Record<string, unknown>): void => {
    let serialized = JSON.stringify(event);
    for (const secret of secretValues) {
      if (secret) serialized = serialized.split(secret).join("[REDACTED_SECRET]");
    }
    const clean = JSON.parse(serialized) as Record<string, unknown>;
    if (agentEvents.length < 400) agentEvents.push({ ...clean, at: new Date().toISOString() });
    logger.info(`nav agent ${String(clean["event"] ?? "progress")}`, {
      service: "navigation",
      action: "nav_agent_progress",
      metadata: {
        run_id: report.run_id,
        application_id: applicationId,
        ...clean,
      },
    });
  };

  const resolved = getStoredJobInspectionTargetByApplicationId(db, applicationId);
  if (!resolved.ok) {
    report.wall = "budget";
    report.notes.push(`target resolution failed: ${resolved.message}`);
    return persist(report);
  }
  report.jobright_job_id = resolved.target.jobrightJobId;

  // The job's own identity — every phase's result is checked against it.
  // A missing company (shouldn't happen) degrades congruence to "unknown",
  // which the persist path treats as human-review territory, never a pass.
  const jobIdentity = getJobIdentity(db, applicationId);

  /** Congruence gate every candidate URL passes before acceptance. */
  const congruent = (url: string): CongruenceVerdict => {
    if (!jobIdentity?.company) {
      return { verdict: "unknown", slug: null, detail: "job has no company on record" };
    }
    return checkUrlCongruence(jobIdentity.company, url);
  };

  // Agent phase (N3) needs the operator's CDP Chrome; when it's available,
  // phases A/B run in the SAME Chrome so the agent continues seamlessly.
  const cfg0 = getConfig();
  const agentAvailability = await resolveAgentAvailability({
    override: input.agentPhaseOverride,
    flagEnabled: cfg0.agentFallbackEnabled,
    cdpUrl: cfg0.agentCdpUrl,
  });
  const agentPhasePossible = agentAvailability.possible;
  if (agentPhasePossible) report.session = "cdp";

  const session: NavSession =
    input.sessionOverride ??
    new PlaywrightServiceSession({
      service: "jobright",
      ...(agentPhasePossible ? { mode: "CDP_ATTACH" as const } : {}),
      headless: input.headless ?? true,
      slowMoMs: 40,
    });

  const callerOwned = input.callerOwnedSession === true && !!input.sessionOverride;
  let navPage: Page | null = null;
  try {
    if (!callerOwned) {
      await session.open();
    }
    const page = await session.newPage({ purpose: "navigation" });
    navPage = page;
    await page.goto(resolved.target.jobUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });

    if (!input.skipAuthLossCheck && (await detectAuthLossOnPage(page, "jobright"))) {
      handleAuthExpiry(db, {
        service: "jobright",
        applicationId,
        detail: "navigation: JobRight session unauthenticated",
      });
      report.wall = "jobright_auth";
      trace({ phase: "open", outcome: "jobright auth loss" });
      return persist(report);
    }
    trace({ phase: "open", outcome: "job page loaded" });

    // JobRight's own modals ("Did you apply?") sit over the page and block
    // every subsequent read/click. Close-control only — never an answer
    // button (this system does not assert what the operator applied to).
    const interstitial = await clearJobRightInterstitial(page);
    if (interstitial.note) report.notes.push(interstitial.note);

    // Dead posting: end here instead of spending phase B + the agent
    // budget on a control that cannot work (operator finding 2026-08-12).
    if (await detectClosedJobBanner(page)) {
      report.wall = "closed";
      trace({
        phase: "open",
        outcome: "posting is CLOSED on JobRight — navigation abandoned",
      });
      report.notes.push(
        "jobright banner says this job has closed; no Apply path exists",
      );
      return persist(report);
    }

    // Phase A — zero mutation. JobRight pages mix apply hrefs with
    // social/press/company-home links; those are not employer application
    // URLs just because they came from JobRight. Store the first
    // non-social apply-shaped href whose congruence matches this job.
    // Mismatch is still a reject (aggregator pages mix employers).
    // Unknown waits for Phase B — Apply click is stronger provenance.
    const hrefs = await readExternalApplyHrefs(page);
    const candidates = selectCandidateApplyLinks(hrefs, hrefs.length);
    let phaseAHref: string | null = null;
    // A JobRight page carries several employers' links (press, LinkedIn,
    // the company site), so a company-name MATCH still wins here — this is
    // ORDERING among many hrefs, not a gate on one. A non-match simply
    // loses the tie-break and phase B's Apply click gets the final say;
    // nothing downstream refuses on the verdict any more.
    for (const href of candidates) {
      if (!looksLikeApplicationUrl(href)) continue;
      const verdict = congruent(href);
      if (verdict.verdict === "match") {
        phaseAHref = href;
        break;
      }
      if (verdict.verdict === "mismatch") {
        report.notes.push(
          `phase A: anchor reads as "${verdict.slug ?? "?"}" (${verdict.detail}) — not preferred, deferring to the Apply click`,
        );
      }
    }
    if (phaseAHref) {
      trace({
        phase: "A_anchor_hrefs",
        outcome: `resolved (${hrefs.length} candidates, employer match)`,
        evidence: new URL(phaseAHref).hostname,
      });
      return resolveAndPersist(report, db, applicationId, phaseAHref, "anchor_href");
    }
    // Name the hosts phase A saw but could not accept: an "N links
    // ignored" count hid that the answer was often sitting in a
    // career-site href the agent was then forbidden to traverse.
    const externalHosts = Array.from(
      new Set(
        hrefs
          .map((h) => {
            try {
              return new URL(h).hostname.toLowerCase();
            } catch {
              return null;
            }
          })
          .filter((h): h is string => h !== null),
      ),
    );
    if (externalHosts.length > 0) {
      report.notes.push(
        `phase A: ${externalHosts.length} external host(s) seen: ${externalHosts
          .slice(0, 10)
          .join(", ")}`,
      );
    }
    report.notes.push(...explainAtsAnchorMisses(hrefs));
    trace({
      phase: "A_anchor_hrefs",
      outcome:
        hrefs.length > 0
          ? `no congruent apply href (${hrefs.length} external links)`
          : "no external anchors",
      ...(externalHosts.length > 0
        ? { evidence: externalHosts.slice(0, 6).join(", ") }
        : {}),
    });

    if (Date.now() > deadline) {
      report.wall = "budget";
      return persist(report);
    }

    // Phase B — guarded click.
    const capture = await clickApplyAndCaptureExternalUrl(
      session as PlaywrightServiceSession,
      page,
    );
    report.notes.push(...capture.notes);
    if (capture.url) {
      // The Apply click's URL IS the application URL (operator directive
      // 2026-08-14: "don't worry about safety in the urls" — every job
      // came off JobRight, a verified board). A landing that shows a
      // sign-in wall is EVIDENCE on the report, not a reason to withhold
      // the URL: the pipeline routes needs_login to fill, and fill owns
      // portal sign-in (086820f) — its pre-mutation gate + portal auth
      // mean application values can never be typed into a login form.
      const captureCong = congruent(capture.url);
      if (captureCong.verdict === "mismatch") {
        // The Apply CLICK produced this URL — the strongest provenance the
        // system has. Record what the hostname says and keep going.
        report.notes.push(
          `phase B: captured URL reads as "${captureCong.slug ?? "?"}" (${captureCong.detail}) — kept, provenance is the Apply click`,
        );
      }
      if (
        capture.landingHtml !== null &&
        detectLoginWall({
          finalUrl: capture.url,
          html: capture.landingHtml,
          title: capture.landingTitle ?? "",
        }).detected
      ) {
        report.notes.push(
          "phase B: landing shows a sign-in wall — stored anyway; fill owns portal auth",
        );
      }
      trace({
        phase: "B_apply_click",
        outcome: `resolved via ${capture.via}`,
        evidence: new URL(capture.url).hostname,
      });
      return resolveAndPersist(
        report,
        db,
        applicationId,
        capture.url,
        capture.via === "popup" ? "apply_click_popup" : "apply_click_same_tab",
      );
    }

    // Classify what we're stuck on (the landing page after the click flow).
    const html = await page.content();
    const finalUrl = page.url();
    const title = await page.title().catch(() => "");
    const captcha = detectBlockingCaptcha({
      finalUrl,
      html,
      title,
      formDetected: false,
      fieldCount: discoverFieldsFromHtml(html).length,
    });
    if (captcha.detected) {
      report.wall = "captcha";
      trace({ phase: "B_apply_click", outcome: "blocking captcha" });
      return persist(report);
    }
    const loginWall = detectLoginWall({ finalUrl, html, title });
    if (loginWall.detected) {
      trace({ phase: "B_apply_click", outcome: "login wall" });
      // Deterministic auth BEFORE the agent: the standing credentials
      // clear a plain sign-in in seconds, where the agent spends minutes
      // of turns (operator directive 2026-08-12 — "when it runs into a
      // new portal, it should navigate and create an account if the login
      // is invalid, and use the same email and password in env"). Every
      // wall is diagnosed either way, so a park is explainable.
      const cleared = await attemptWallAuth(finalUrl);
      if (cleared) {
        trace({
          phase: "B_portal_auth",
          outcome: "login wall cleared deterministically",
          evidence: safeHostOf(finalUrl),
        });
        return resolveAndPersist(report, db, applicationId, finalUrl, "portal_auth");
      }
      if (!agentPhasePossible) {
        report.wall = "auth";
        return persist(report);
      }
      // The agent phase can attempt the wall (sign-in / account flow).
    } else {
      trace({
        phase: "B_apply_click",
        outcome: "unresolved by deterministic phases",
      });
    }

    // Phase C — agent (guarded by AGENT_FALLBACK_ENABLED + reachable CDP).
    if (!agentPhasePossible) {
      // Say WHY in the trace: an L3 session report full of bare
      // "budget" walls hides that these apps only needed the agent phase,
      // which an unattended headless child can never run (no operator CDP).
      trace({
        phase: "C_agent",
        outcome: `skipped: agent phase unavailable (${agentAvailability.reason ?? "unknown"})`,
      });
      report.notes.push(
        `unresolved by deterministic phases; agent phase unavailable: ${agentAvailability.reason ?? "unknown"}`,
      );
      // NOT "budget". Live 2026-08-14: every unresolved app in an armed
      // session reported wall=budget while the trace said "CDP Chrome
      // unreachable at http://127.0.0.1:9222" — a fixable operator setting
      // read as an exhausted attempt. Name it for what it is.
      report.wall = "agent_unavailable";
      return persist(report);
    }
    if (Date.now() > deadline) {
      report.wall = "budget";
      return persist(report);
    }

    const startUrl =
      finalUrl && finalUrl !== "about:blank" ? finalUrl : resolved.target.jobUrl;

    // Deterministic-first host policy: telemetry says whether the agent has
    // ever cleared this host. A host with repeated all-fail agent runs
    // parks immediately — the agent budget goes to hosts it can win.
    const policyHost = startUrl.startsWith("https://")
      ? new URL(startUrl).hostname
      : null;
    const hostPolicy = evaluateAgentHostPolicy(db, policyHost);
    if (!hostPolicy.runAgent) {
      trace({
        phase: "C_agent",
        outcome: `skipped: ${hostPolicy.reason}`,
      });
      report.notes.push(hostPolicy.reason);
      report.wall = "budget";
      return persist(report);
    }
    // The agent may traverse every non-social host the job page itself
    // linked to, plus the captured start URL. Traversal ≠ acceptance:
    // congruence and the final_url validation in navigateViaSidecar
    // still gate what is stored. There is no hardcoded ATS-host allowlist
    // — JobRight is the source of the hrefs; leftover CDP tabs are not.
    const jobPageHosts = traversalHosts(hrefs);
    // Career sites redirect across sibling domains of the same brand
    // (joinbytedance.com -> jobs.bytedance.com, live 2026-08-12). Allow the
    // registrable domains so the agent is not demoted for following the
    // real apply path; acceptance still runs congruence + URL validation.
    const siblingHosts = employerSiblingHosts(hrefs, jobIdentity?.company ?? null);
    const allowedDomains = Array.from(
      new Set([
        "jobright.ai",
        ...(startUrl.startsWith("https://") ? [new URL(startUrl).hostname] : []),
        ...jobPageHosts,
        ...siblingHosts,
      ]),
    ).slice(0, 25);
    if (jobPageHosts.length > 0) {
      report.notes.push(
        `agent allowed_domains widened with job-page hosts: ${jobPageHosts
          .slice(0, 10)
          .join(", ")}`,
      );
    }

    // Account credentials (N5) — the isolated verification subsystem owns
    // the policy (reuse vault entry; mint only on a live login wall; never
    // for jobright). Secrets ride only the in-memory task → sidecar stdin;
    // the artifact path scrubs them (see persist).
    const wallHost = startUrl.startsWith("https://")
      ? new URL(startUrl).hostname
      : null;
    const credPrep = prepareCredentialsForHost({
      host: wallHost,
      runId: report.run_id,
      loginWallDetected: loginWall.detected,
    });
    const credentials: AgentNavigateTask["credentials"] = credPrep.credentials;
    report.notes.push(...credPrep.notes);
    secretValues.push(...credPrep.secrets);

    // Turn loop: 1 initial spawn + up to 2 mailbox continuations. The
    // verification subsystem decides availability (Gmail readonly client,
    // Outlook read-only session — both fail-closed behind their flags).
    const gmailAvailable =
      input.gmailWaiterOverride !== undefined || emailVerificationAvailable();
    let turns = 0;
    let totalSteps = 0;
    const visited = new Set<string>();
    let turnStartUrl = startUrl;
    let resume: AgentNavigateTask["resume"];
    // The agent must know WHO it is navigating for: the live failure this
    // guards against was a goal that never named the employer, so a
    // leftover application-form tab (any company's) read as success.
    const targetLabel = jobIdentity
      ? `the posting "${jobIdentity.role}" at ${jobIdentity.company}`
      : "this posting";
    // The job page's own external links are the strongest leads — the run
    // that resolved navigated DIRECTLY; the runs that thrashed scrolled
    // jobright hunting for a control that isn't there. Name the links.
    const candidateLinks = selectCandidateApplyLinks(hrefs);
    // ASCII ONLY. The task rides stdin into Python; a single non-ASCII
    // character (this string used to carry an em dash) made browser-use
    // reject the whole task on Windows. The encoding is fixed on both
    // ends now — keeping the text ASCII is the second line of defense.
    const linksHint =
      candidateLinks.length > 0
        ? ` The job page links to these external pages which likely lead to the ` +
          `application: OPEN THE MOST PROMISING ONE DIRECTLY (navigate to its URL) ` +
          `instead of searching the current page: ${candidateLinks.join(" | ")}.`
        : "";
    if (candidateLinks.length > 0) {
      report.notes.push(
        `agent goal seeded with ${candidateLinks.length} candidate link(s) from the job page`,
      );
    }
    const baseGoal =
      `Reach the employer's job-application form page for ${targetLabel}, ` +
      `starting from the current page. Only an application page belonging to ` +
      `${jobIdentity?.company ?? "this job's employer"} counts — never return ` +
      `an application form for a different company, and do not reuse ` +
      `previously open tabs for other jobs.` +
      linksHint;
    let correction: string | null = null;
    try {
      while (turns < 3 && Date.now() < deadline) {
        logger.info("nav agent turn starting", {
          service: "navigation",
          action: "nav_agent_turn_begin",
          metadata: {
            run_id: report.run_id,
            application_id: applicationId,
            turn: turns + 1,
            start_host: turnStartUrl.startsWith("https://")
              ? new URL(turnStartUrl).hostname
              : null,
            corrective: correction !== null,
          },
        });
        const agentResult = await navigateViaSidecar({
          onProgress: onAgentProgress,
          task: {
            task_version: 1,
            task_type: "navigate",
            goal: correction ? `${baseGoal} ${correction}` : baseGoal,
            start_url: turnStartUrl,
            cdp_url: cfg0.agentCdpUrl,
            allowed_domains: allowedDomains,
            max_steps: 25,
            timeout_ms: Math.max(
              30_000,
              Math.min(180_000, deadline - Date.now()),
            ),
            credentials,
            gmail_available: gmailAvailable,
            ...(resume ? { resume } : {}),
          },
          ...(input.agentCommandOverride
            ? { commandOverride: input.agentCommandOverride }
            : {}),
        });
        turns++;
        totalSteps += agentResult.steps_used;
        for (const d of agentResult.domains_visited) visited.add(d);
        report.agent = {
          turns_used: turns,
          steps_used: totalSteps,
          domains_visited: [...visited],
        };
        // Turn summary streams even on zero-step failures — the live case
        // this exists for (a wedged CDP attach dies before the first step,
        // which no step stream can ever show).
        logger.info("nav agent turn finished", {
          service: "navigation",
          action: "nav_agent_turn_end",
          metadata: {
            run_id: report.run_id,
            application_id: applicationId,
            turn: turns,
            status: agentResult.status,
            wall: agentResult.wall,
            steps_used: agentResult.steps_used,
            domains_visited: agentResult.domains_visited,
            ...(agentResult.reason ? { reason: agentResult.reason.slice(0, 200) } : {}),
          },
        });
        report.notes.push(...agentResult.notes.map((n) => `agent[${turns}]: ${n}`));
        // A zero-step error's cause lives ONLY in `reason` — three live
        // failures shipped with empty notes and were undiagnosable until
        // the operator's logs were correlated by hand. Never again.
        if (agentResult.status === "error" && agentResult.reason) {
          report.notes.push(`agent[${turns}] reason: ${agentResult.reason.slice(0, 300)}`);
          if (/cdp|connect|websocket|timeout/i.test(agentResult.reason) && agentResult.steps_used === 0) {
            report.notes.push(
              "agent could not attach to the debug Chrome (port answers but the session is wedged) — close ALL Chrome windows, re-run chrome:debug:jobright, then requeue",
            );
          }
        }

        if (agentResult.status === "ok" && agentResult.final_url) {
          // The agent's word is a proposal, not a result: verify the URL
          // belongs to this job's employer before accepting. One corrective
          // retry per rejection, inside the existing turn cap.
          const cong = congruent(agentResult.final_url);
          if (cong.verdict === "mismatch") {
            // Recorded, not retried. Burning a turn to make the agent
            // re-find a page it already reached is the "took way too long"
            // the operator sees; the hostname disagreeing with the company
            // name is usually the ATS vendor's name, not a wrong employer.
            report.notes.push(
              `agent[${turns}]: URL reads as "${cong.slug ?? "?"}" (${cong.detail}) — kept`,
            );
          }
          trace({
            phase: "C_agent",
            outcome: `resolved (turn ${turns}, employer ${cong.verdict === "match" ? "match" : "unverified"})`,
            evidence: new URL(agentResult.final_url).hostname,
          });
          return resolveAndPersist(
            report,
            db,
            applicationId,
            agentResult.final_url,
            "agent",
          );
        }

        if (agentResult.status === "needs_input" && agentResult.need) {
          report.need = agentResult.need;
          // Operator rule: the mailbox is scanned ONLY when the page
          // actually asked for verification — the need must carry page
          // evidence saying so. An agent claiming "check email" without a
          // verification prompt on screen is a hallucinated need, not a
          // reason to read the operator's inbox.
          if (!verificationEvidencePresent(agentResult.need.evidence)) {
            report.wall = "auth";
            trace({
              phase: "C_agent",
              outcome:
                "needs_input WITHOUT verification evidence on the page — mailbox not consulted, human review",
            });
            report.notes.push(
              "verification need rejected: agent's page evidence shows no verification prompt",
            );
            return persist(report);
          }
          const waiter =
            input.gmailWaiterOverride ?? resolveNavVerificationWaiter();
          if (!waiter) {
            report.wall = "auth";
            trace({
              phase: "C_agent",
              outcome:
                "needs email verification — no mailbox provider enabled (GMAIL_VERIFICATION_ENABLED / OUTLOOK_VERIFICATION_ENABLED), human review",
            });
            return persist(report);
          }
          if (turns >= 3) break;
          const wait = await waiter(agentResult.need, allowedDomains);
          report.gmail = {
            polls_used: (report.gmail?.polls_used ?? 0) + wait.pollsUsed,
            matched_message_id:
              wait.kind === "timeout" ? null : wait.messageId,
          };
          if (wait.kind === "timeout") {
            report.wall = "auth";
            trace({
              phase: "D_gmail",
              outcome: "verification email not found within the poll budget",
            });
            return persist(report);
          }
          trace({
            phase: "D_gmail",
            outcome: `verification ${wait.kind} retrieved`,
          });
          // Codes/links are secrets: the continuation task carries them,
          // and any echo of them must be scrubbed from the artifact.
          secretValues.push(wait.kind === "code" ? wait.code : wait.url);
          resume = {
            prior_run_id: report.run_id,
            prior_final_url:
              agentResult.final_url ?? turnStartUrl,
            injected:
              wait.kind === "code"
                ? { kind: "verification_code", code: wait.code }
                : { kind: "magic_link", url: wait.url },
          };
          turnStartUrl = agentResult.final_url ?? turnStartUrl;
          continue;
        }

        report.wall = agentResult.wall === "none" ? "budget" : agentResult.wall;
        trace({
          phase: "C_agent",
          outcome: `wall: ${report.wall} (turn ${turns})`,
        });
        // PR #35's prediction FAILED here: three live auth walls on
        // 2026-08-12 carried no `login_wall` block, because the agent
        // reports "stopped: auth" on its own and never passes through the
        // deterministic phase-B branch where the diagnosis was wired. Give
        // the agent's auth stop the same treatment — diagnose, and let the
        // standing credentials try — using the URL the agent parked on.
        const agentWallUrl = agentResult.final_url ?? turnStartUrl;
        if (report.wall === "auth" && agentWallUrl) {
          if (await attemptWallAuth(agentWallUrl)) {
            trace({
              phase: "C_portal_auth",
              outcome: "agent auth wall cleared deterministically",
              evidence: safeHostOf(agentWallUrl),
            });
            return resolveAndPersist(
              report,
              db,
              applicationId,
              agentWallUrl,
              "portal_auth",
            );
          }
        }
        return persist(report);
      }
      report.wall = "budget";
      trace({
        phase: "C_agent",
        outcome: "turn/deadline budget exhausted",
      });
      return persist(report);
    } catch (err) {
      report.notes.push(
        `agent phase failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      report.wall = "budget";
      trace({ phase: "C_agent", outcome: "error" });
      return persist(report);
    }
  } finally {
    if (callerOwned) {
      // The session lives on for the next app; only this run's tab dies —
      // otherwise a 25-app armed loop accumulates 25 tabs.
      await navPage?.close().catch(() => undefined);
    } else {
      await session.close().catch(() => undefined);
    }
  }

  function safeHostOf(url: string): string {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return "";
    }
  }

  /**
   * Deterministic pass at an employer login wall, on its own page so the
   * JobRight tab is never navigated away. ALWAYS diagnoses (that read is
   * the debuggability the operator asked for); only types credentials when
   * portalAuth's own host gate agrees. Fail-open: any error here just
   * means the agent phase / park path continues as before.
   */
  async function attemptWallAuth(wallUrl: string): Promise<boolean> {
    let parsed: URL;
    try {
      parsed = new URL(wallUrl);
    } catch {
      return false;
    }
    if (parsed.protocol !== "https:") return false;
    if (/(^|\.)jobright\.ai$/i.test(parsed.hostname)) return false;

    let wallPage: Page | null = null;
    try {
      wallPage = await session.newPage({ purpose: "portal-auth" });
      await wallPage.goto(wallUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      // Cookie/consent banners sit over the sign-in form and swallow the
      // click (operator: "when it runs into cookies on job pages it should
      // click accept all"). Bounded + never-click screened.
      const obstructions = await dismissPageObstructions(wallPage);
      if (obstructions.dismissed.length > 0) {
        report.notes.push(
          `portal page popups dismissed: ${obstructions.dismissed.join(", ")}`,
        );
      }
      report.login_wall = await diagnoseLoginWall(wallPage);
      report.notes.push(summarizeLoginWall(report.login_wall));

      const { authenticateAtsPortal, isRecognizedAtsAuthHost } = await import(
        "../verification/portalAuth.js"
      );
      if (!isRecognizedAtsAuthHost(wallUrl)) {
        report.notes.push(
          `portal auth not attempted: ${parsed.hostname} is not an authorized auth host (set PORTAL_LOGIN_EMAIL/PASSWORD to authorize employer portals)`,
        );
        return false;
      }
      const auth = await authenticateAtsPortal(wallPage);
      secretValues.push(...auth.secrets);
      report.notes.push(...auth.notes);
      return auth.status === "signed_in" || auth.status === "account_created";
    } catch (err) {
      report.notes.push(
        `portal auth attempt failed (wall unchanged): ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`,
      );
      return false;
    } finally {
      await wallPage?.close().catch(() => undefined);
    }
  }

  function resolveAndPersist(
    r: NavigationReport,
    database: Db,
    appId: string,
    url: string,
    method: NavigationMethod,
  ): NavigationReport {
    // Congruence is EVIDENCE, not a gate (operator directive 2026-08-14:
    // "it literally should not matter whether the system proceeds… other
    // than for logging"). Every posting reaches this system through
    // JobRight, a verified board, and the URL came from that posting's own
    // Apply path — so a hostname that shares no letters with the company
    // name is a fact worth recording, never a reason to throw the link
    // away. It was costing real applications: secure7.saashr.com (TRG) and
    // paycomonline.net (Union Home Mortgage) were both correct and both
    // discarded. The verdict rides on every report and every stored row.
    const cong = congruent(url);
    r.congruence = {
      ...cong,
      expected_company: jobIdentity?.company ?? "(unknown)",
      url,
    };
    if (cong.verdict === "mismatch") {
      r.notes.push(
        `congruence: URL names "${cong.slug ?? "?"}", not "${jobIdentity?.company ?? "(unknown)"}" (${cong.detail}) — recorded, not refused`,
      );
    }
    if (cong.verdict === "unknown") {
      // Evidence only — the generic adapter fills the long tail, so an
      // unverifiable hostname no longer routes anywhere by itself.
      r.notes.push(`employer congruence unverifiable (${cong.detail}) — recorded`);
    }

    // One posting, one application: a URL already held by another live
    // application is a duplicate (stale agent tab or JobRight double
    // listing) — park it instead of building a second submission.
    const dupes = findApplicationsWithEmployerUrl(database, url, appId);
    if (dupes.length > 0) {
      r.duplicates = dupes;
      r.notes.push(
        `employer URL already held by ${dupes.length} other application(s): ${dupes
          .map((d) => `${d.application_id.slice(0, 8)} (${d.company} — ${d.role}, ${d.state})`)
          .join("; ")}`,
      );
      r.wall = "duplicate_url";
      return persist(r);
    }

    try {
      const stored = storeResolvedEmployerUrl(database, appId, url, {
        runId: r.run_id,
        session: r.session,
      });
      r.method = method;
      r.resolved_url = stored.url;
      r.resolved_ats = stored.ats;
      r.wall = "none";
    } catch (err) {
      r.notes.push(
        `resolved URL refused by store policy: ${err instanceof Error ? err.message : String(err)}`,
      );
      r.wall = "budget";
    }
    return persist(r);
  }

  function persist(r: NavigationReport): NavigationReport {
    const cfg = getConfig();
    const outDir = path.join(cfg.artifactsDir, "navigation", r.run_id);
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, "report.json");

    // Agent trace artifact — the behavioral-cloning corpus row for this
    // episode: era-stamped, scrubbed step/heartbeat events joined to the
    // deterministic outcome label (congruence verdict + wall). One JSONL
    // line per event, header first. Written only when the agent ran.
    let traceRelpath: string | null = null;
    if (agentEvents.length > 0) {
      try {
        const tracePath = path.join(outDir, "agent-trace.jsonl");
        const header = {
          kind: "nav_agent_trace",
          version: 1,
          run_id: r.run_id,
          application_id: r.application_id,
          code_version: codeVersion(),
          session: r.session,
          outcome: {
            wall: r.wall,
            method: r.method,
            resolved: r.resolved_url !== null,
            congruence: r.congruence?.verdict ?? null,
          },
        };
        let body =
          [header, ...agentEvents].map((e) => JSON.stringify(e)).join("\n") + "\n";
        for (const secret of secretValues) {
          if (secret) body = body.split(secret).join("[REDACTED_SECRET]");
        }
        fs.writeFileSync(tracePath, body, "utf8");
        traceRelpath = path.relative(cfg.artifactsDir, tracePath);
      } catch {
        // trace is telemetry — never fail the run over it
      }
    }
    const redacted = redactObject({
      ...r,
      written_at: new Date().toISOString(),
    } as unknown as Record<string, unknown>);
    // Defense in depth: even if a sidecar note echoed a credential, the
    // literal value never reaches disk — scrub both the raw form and the
    // JSON-escaped form (passwords with quotes/backslashes serialize
    // differently than they read).
    let serialized = JSON.stringify(redacted);
    for (const secret of secretValues) {
      if (!secret) continue;
      const escaped = JSON.stringify(secret).slice(1, -1);
      for (const needle of new Set([secret, escaped])) {
        serialized = serialized.split(needle).join("[REDACTED_SECRET]");
      }
    }
    writeJsonAtomic(outPath, JSON.parse(serialized) as Record<string, unknown>);
    r.report_path = outPath;
    // Telemetry row (fail-open): joins to this artifact + logs via run_id.
    recordNavigationAttempt(
      {
        report: r,
        startUrl: resolved.ok ? resolved.target.jobUrl : null,
        durationMs: Date.now() - startedAt,
        traceRelpath,
      },
      { db },
    );
    logger.info("navigation run finished", {
      service: "navigation",
      action: "nav_run",
      metadata: {
        run_id: r.run_id,
        application_id: r.application_id,
        method: r.method,
        wall: r.wall,
        resolved_ats: r.resolved_ats,
        employer_url: r.resolved_url ?? null,
        notes: r.notes.slice(0, 12),
        phase_trace: r.phase_trace,
        report_path: r.report_path ?? null,
        headless: input.headless ?? true,
      },
    });
    return r;
  }
}
