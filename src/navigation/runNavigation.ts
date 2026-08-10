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
import { assertNavigationAllowed } from "./navigationGuards.js";
import { storeResolvedEmployerUrl } from "./storeResult.js";
import { detectAtsFromUrl } from "../ats/shared/urlValidationDispatch.js";
import { recordNavigationAttempt } from "../storage/navSubmitOutcomes.js";
import { codeVersion } from "../storage/codeVersion.js";
import { evaluateAgentHostPolicy } from "./hostPolicy.js";
import {
  explainAtsAnchorMisses,
  selectCandidateApplyLinks,
  traversalHosts,
} from "./candidateLinks.js";
import {
  checkUrlCongruence,
  findApplicationsWithEmployerUrl,
  getJobIdentity,
  type CongruenceVerdict,
} from "./congruence.js";

function detectAtsFromUrlSafe(url: string): boolean {
  return detectAtsFromUrl(url).ats !== null;
}

/** Hosts the nav agent may traverse in addition to the job page's own. */
const KNOWN_ATS_HOSTS = [
  "boards.greenhouse.io",
  "job-boards.greenhouse.io",
  "greenhouse.io",
  "jobs.lever.co",
  "jobs.eu.lever.co",
  "jobs.ashbyhq.com",
  "apply.workable.com",
];

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
  | "submit_risk"
  /** Resolved URL belongs to a different employer than the job record. */
  | "mismatch"
  /** Another live application already holds this employer URL. */
  | "duplicate_url";

export type NavigationMethod =
  | "anchor_href"
  | "apply_click_popup"
  | "apply_click_same_tab"
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

  try {
    await session.open();
    const page = await session.newPage({ purpose: "navigation" });
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

    // Phase A — zero mutation. Only a KNOWN-ATS href resolves here: the
    // any-anchor fallback also matches footer/social links, and phase A
    // applies none of the landing-page checks phase B does, so an
    // arbitrary https href must never be stored as the employer URL.
    const hrefs = await readExternalApplyHrefs(page);
    const atsHrefs = hrefs.filter((h) => detectAtsFromUrlSafe(h));
    // Identity before acceptance: an anchor pointing at a known ATS but a
    // DIFFERENT employer's board (aggregator pages mix them) must not win.
    const atsHref = atsHrefs.find((h) => congruent(h).verdict === "match");
    for (const rejected of atsHrefs.filter((h) => congruent(h).verdict === "mismatch")) {
      report.notes.push(
        `phase A: known-ATS anchor rejected — ${congruent(rejected).detail}`,
      );
    }
    if (atsHref) {
      trace({
        phase: "A_anchor_hrefs",
        outcome: `resolved (known ATS, ${hrefs.length} candidates, employer match)`,
        evidence: new URL(atsHref).hostname,
      });
      return resolveAndPersist(report, db, applicationId, atsHref, "anchor_href");
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
    const ignoredHosts = externalHosts.filter(
      (h) => !atsHrefs.some((a) => new URL(a).hostname.toLowerCase() === h),
    );
    if (ignoredHosts.length > 0) {
      report.notes.push(
        `phase A: ${ignoredHosts.length} non-ATS external host(s) seen: ${ignoredHosts
          .slice(0, 10)
          .join(", ")}`,
      );
    }
    report.notes.push(...explainAtsAnchorMisses(hrefs));
    trace({
      phase: "A_anchor_hrefs",
      outcome:
        hrefs.length > 0
          ? `no known-ATS anchors (${hrefs.length} external links ignored)`
          : "no external anchors",
      ...(ignoredHosts.length > 0
        ? { evidence: ignoredHosts.slice(0, 6).join(", ") }
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
    let capturedWallUrl: string | null = null;
    if (capture.url) {
      // A captured URL is only "resolved" when the landing page is not a
      // wall — an employer sign-in page must never be stored as the
      // application URL; it becomes the agent phase's starting point.
      const knownAts = detectAtsFromUrlSafe(capture.url);
      const landingWall =
        !knownAts &&
        capture.landingHtml !== null &&
        detectLoginWall({
          finalUrl: capture.url,
          html: capture.landingHtml,
          title: capture.landingTitle ?? "",
        }).detected;
      const captureCong = congruent(capture.url);
      if (captureCong.verdict === "mismatch") {
        report.notes.push(
          `phase B: captured URL rejected — ${captureCong.detail}`,
        );
        trace({
          phase: "B_apply_click",
          outcome: "captured URL belongs to a different employer — not stored",
          evidence: new URL(capture.url).hostname,
        });
      } else if (!landingWall) {
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
      } else {
        // A wrong-employer capture must NOT become the agent's start page —
        // only a genuine same-employer login wall is worth continuing from.
        capturedWallUrl = capture.url;
        trace({
          phase: "B_apply_click",
          outcome: "captured URL lands on a login wall — not stored",
          evidence: new URL(capture.url).hostname,
        });
      }
    }

    // Classify what we're stuck on (the landing page after the click flow).
    const html = capturedWallUrl
      ? (capture.landingHtml ?? (await page.content()))
      : await page.content();
    const finalUrl = capturedWallUrl ?? page.url();
    const title = capturedWallUrl
      ? (capture.landingTitle ?? "")
      : await page.title().catch(() => "");
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
      report.wall = "budget";
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
    // The agent may traverse every external host the job page itself
    // linked to (career sites that front the real ATS) — the previous
    // jobright+known-ATS-only cage made "find Apply on the company site"
    // structurally unwinnable. Traversal ≠ acceptance: congruence and the
    // final_url validation in navigateViaSidecar still gate what is stored.
    const jobPageHosts = traversalHosts(hrefs);
    const allowedDomains = Array.from(
      new Set([
        "jobright.ai",
        ...KNOWN_ATS_HOSTS,
        ...(startUrl.startsWith("https://") ? [new URL(startUrl).hostname] : []),
        ...jobPageHosts,
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
    const linksHint =
      candidateLinks.length > 0
        ? ` The job page links to these external pages which likely lead to the ` +
          `application — OPEN THE MOST PROMISING ONE DIRECTLY (navigate to its URL) ` +
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
    let lastMismatch:
      | (CongruenceVerdict & { url: string })
      | null = null;
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
            lastMismatch = { ...cong, url: agentResult.final_url };
            trace({
              phase: "C_agent",
              outcome: `rejected (turn ${turns}): wrong employer — ${cong.detail}`,
              evidence: new URL(agentResult.final_url).hostname,
            });
            report.notes.push(
              `agent[${turns}]: returned wrong-employer URL (${cong.detail}) — corrective retry`,
            );
            correction =
              `IMPORTANT: on a previous attempt you returned ` +
              `${agentResult.final_url}, which belongs to a different ` +
              `company ("${cong.slug}"), not ${jobIdentity?.company ?? "the target employer"}. ` +
              `That was wrong. Start over from the job posting page and find ` +
              `the application page for ${jobIdentity?.company ?? "the correct employer"} only.`;
            turnStartUrl = resolved.target.jobUrl;
            resume = undefined;
            continue;
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
        return persist(report);
      }
      if (lastMismatch) {
        // Every accepted-looking answer was for the wrong employer — park
        // as a mismatch (with the evidence), not an anonymous budget wall.
        report.wall = "mismatch";
        report.congruence = {
          ...lastMismatch,
          expected_company: jobIdentity?.company ?? "(unknown)",
        };
        trace({
          phase: "C_agent",
          outcome: `exhausted turns — every candidate URL belonged to a different employer (last: ${lastMismatch.slug ?? "?"})`,
        });
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
    await session.close().catch(() => undefined);
  }

  function resolveAndPersist(
    r: NavigationReport,
    database: Db,
    appId: string,
    url: string,
    method: NavigationMethod,
  ): NavigationReport {
    // Backstop identity check — phases pre-filter, but nothing may be
    // persisted that fails congruence, whatever path proposed it.
    const cong = congruent(url);
    r.congruence = {
      ...cong,
      expected_company: jobIdentity?.company ?? "(unknown)",
      url,
    };
    if (cong.verdict === "mismatch") {
      r.notes.push(`refusing to store wrong-employer URL: ${cong.detail}`);
      r.wall = "mismatch";
      return persist(r);
    }
    if (cong.verdict === "unknown") {
      r.notes.push(
        `employer congruence unverifiable (${cong.detail}) — URL routes to human review via the unsupported-ATS path`,
      );
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
