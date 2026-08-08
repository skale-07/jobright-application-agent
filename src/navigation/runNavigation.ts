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
import { GmailClient } from "../gmail/client.js";
import {
  waitForVerificationEmail,
  type VerificationWaitResult,
} from "../gmail/waitForVerification.js";
import { readGmailToken } from "../gmail/tokenStore.js";
import { getAccount, getOrCreateAccount } from "../accounts/vault.js";
import { loadPublicProfile } from "../candidate/publicProfileIO.js";
import { assertNavigationAllowed } from "./navigationGuards.js";
import { storeResolvedEmployerUrl } from "./storeResult.js";
import { detectAtsFromUrl } from "../ats/shared/urlValidationDispatch.js";

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
];

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
  | "submit_risk";

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

/** Production Gmail waiter — bounded polls against the readonly client. */
async function defaultGmailWaiter(
  need: NonNullable<AgentNavigateResult["need"]>,
  allowedDomains: string[],
): Promise<VerificationWaitResult> {
  const client = new GmailClient();
  return waitForVerificationEmail({
    client,
    need,
    extraAllowedDomains: allowedDomains,
  });
}

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
  const deadline = Date.now() + TOTAL_WALLCLOCK_MS;

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
  };

  /** Values that must never reach the artifact, whatever echoes them. */
  const secretValues: string[] = [];

  const resolved = getStoredJobInspectionTargetByApplicationId(db, applicationId);
  if (!resolved.ok) {
    report.wall = "budget";
    report.notes.push(`target resolution failed: ${resolved.message}`);
    return persist(report);
  }
  report.jobright_job_id = resolved.target.jobrightJobId;

  // Agent phase (N3) needs the operator's CDP Chrome; when it's available,
  // phases A/B run in the SAME Chrome so the agent continues seamlessly.
  const cfg0 = getConfig();
  const agentPhasePossible =
    input.agentPhaseOverride ??
    (cfg0.agentFallbackEnabled && (await probeCdpEndpoint(cfg0.agentCdpUrl)));
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
      report.phase_trace.push({ phase: "open", outcome: "jobright auth loss" });
      return persist(report);
    }
    report.phase_trace.push({ phase: "open", outcome: "job page loaded" });

    // Phase A — zero mutation. Only a KNOWN-ATS href resolves here: the
    // any-anchor fallback also matches footer/social links, and phase A
    // applies none of the landing-page checks phase B does, so an
    // arbitrary https href must never be stored as the employer URL.
    const hrefs = await readExternalApplyHrefs(page);
    const atsHref = hrefs.find((h) => detectAtsFromUrlSafe(h));
    if (atsHref) {
      report.phase_trace.push({
        phase: "A_anchor_hrefs",
        outcome: `resolved (known ATS, ${hrefs.length} candidates)`,
        evidence: new URL(atsHref).hostname,
      });
      return resolveAndPersist(report, db, applicationId, atsHref, "anchor_href");
    }
    report.phase_trace.push({
      phase: "A_anchor_hrefs",
      outcome:
        hrefs.length > 0
          ? `no known-ATS anchors (${hrefs.length} external links ignored)`
          : "no external anchors",
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
      if (!landingWall) {
        report.phase_trace.push({
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
      capturedWallUrl = capture.url;
      report.phase_trace.push({
        phase: "B_apply_click",
        outcome: "captured URL lands on a login wall — not stored",
        evidence: new URL(capture.url).hostname,
      });
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
      report.phase_trace.push({ phase: "B_apply_click", outcome: "blocking captcha" });
      return persist(report);
    }
    const loginWall = detectLoginWall({ finalUrl, html, title });
    if (loginWall.detected) {
      report.phase_trace.push({ phase: "B_apply_click", outcome: "login wall" });
      if (!agentPhasePossible) {
        report.wall = "auth";
        return persist(report);
      }
      // The agent phase can attempt the wall (sign-in / account flow).
    } else {
      report.phase_trace.push({
        phase: "B_apply_click",
        outcome: "unresolved by deterministic phases",
      });
    }

    // Phase C — agent (guarded by AGENT_FALLBACK_ENABLED + reachable CDP).
    if (!agentPhasePossible) {
      report.wall = "budget";
      return persist(report);
    }
    if (Date.now() > deadline) {
      report.wall = "budget";
      return persist(report);
    }

    const startUrl =
      finalUrl && finalUrl !== "about:blank" ? finalUrl : resolved.target.jobUrl;
    const allowedDomains = Array.from(
      new Set(
        [
          "jobright.ai",
          ...KNOWN_ATS_HOSTS,
          ...(startUrl.startsWith("https://")
            ? [new URL(startUrl).hostname]
            : []),
        ].slice(0, 20),
      ),
    );

    // Account credentials (N5): reuse a vault entry for the wall host, or
    // mint one when the landing page is a login wall (an account will be
    // needed either way). Secrets ride only the in-memory task → sidecar
    // stdin; the artifact path scrubs them (see persist).
    const wallHost = startUrl.startsWith("https://")
      ? new URL(startUrl).hostname
      : null;
    let credentials: AgentNavigateTask["credentials"] = { available: false };
    if (wallHost && !/(^|\.)jobright\.ai$/i.test(wallHost)) {
      const existing = getAccount(wallHost);
      if (existing) {
        credentials = {
          available: true,
          username: existing.username,
          password: existing.password,
        };
        report.notes.push(`vault: existing account for ${wallHost}`);
      } else if (loginWall.detected) {
        const email =
          readGmailToken()?.account_email ??
          (() => {
            try {
              return loadPublicProfile().email;
            } catch {
              return "";
            }
          })();
        if (email) {
          const { account, created } = getOrCreateAccount(wallHost, {
            email,
            runId: report.run_id,
          });
          credentials = {
            available: true,
            username: account.username,
            password: account.password,
          };
          report.notes.push(
            `vault: ${created ? "created" : "loaded"} account for ${wallHost}`,
          );
        }
      }
    }
    if (credentials.password) secretValues.push(credentials.password);

    // Turn loop: 1 initial spawn + up to 2 Gmail continuations.
    const gmailAvailable = cfg0.gmailVerificationEnabled;
    let turns = 0;
    let totalSteps = 0;
    const visited = new Set<string>();
    let turnStartUrl = startUrl;
    let resume: AgentNavigateTask["resume"];
    try {
      while (turns < 3 && Date.now() < deadline) {
        const agentResult = await navigateViaSidecar({
          task: {
            task_version: 1,
            task_type: "navigate",
            goal: "Reach the employer's job-application form page for this posting, starting from the current page.",
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
        report.notes.push(...agentResult.notes.map((n) => `agent[${turns}]: ${n}`));

        if (agentResult.status === "ok" && agentResult.final_url) {
          report.phase_trace.push({
            phase: "C_agent",
            outcome: `resolved (turn ${turns})`,
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
          const waiter = input.gmailWaiterOverride ?? defaultGmailWaiter;
          if (!gmailAvailable && !input.gmailWaiterOverride) {
            report.wall = "auth";
            report.phase_trace.push({
              phase: "C_agent",
              outcome:
                "needs email verification — GMAIL_VERIFICATION_ENABLED=false, human review",
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
            report.phase_trace.push({
              phase: "D_gmail",
              outcome: "verification email not found within the poll budget",
            });
            return persist(report);
          }
          report.phase_trace.push({
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
        report.phase_trace.push({
          phase: "C_agent",
          outcome: `wall: ${report.wall} (turn ${turns})`,
        });
        return persist(report);
      }
      report.wall = "budget";
      report.phase_trace.push({
        phase: "C_agent",
        outcome: "turn/deadline budget exhausted",
      });
      return persist(report);
    } catch (err) {
      report.notes.push(
        `agent phase failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      report.wall = "budget";
      report.phase_trace.push({ phase: "C_agent", outcome: "error" });
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
