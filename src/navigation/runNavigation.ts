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
import { assertNavigationAllowed } from "./navigationGuards.js";
import { storeResolvedEmployerUrl } from "./storeResult.js";

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
    session: "ephemeral",
    notes: [],
  };

  const resolved = getStoredJobInspectionTargetByApplicationId(db, applicationId);
  if (!resolved.ok) {
    report.wall = "budget";
    report.notes.push(`target resolution failed: ${resolved.message}`);
    return persist(report);
  }
  report.jobright_job_id = resolved.target.jobrightJobId;

  const session: NavSession =
    input.sessionOverride ??
    new PlaywrightServiceSession({
      service: "jobright",
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

    // Phase A — zero mutation.
    const hrefs = await readExternalApplyHrefs(page);
    if (hrefs.length > 0 && hrefs[0]) {
      report.phase_trace.push({
        phase: "A_anchor_hrefs",
        outcome: `resolved (${hrefs.length} candidates)`,
        evidence: new URL(hrefs[0]).hostname,
      });
      return resolveAndPersist(report, db, applicationId, hrefs[0], "anchor_href");
    }
    report.phase_trace.push({ phase: "A_anchor_hrefs", outcome: "no external anchors" });

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

    // Classify what we're stuck on (the landing page after the click flow).
    const html = await page.content();
    const finalUrl = page.url();
    const title = await page.title().catch(() => "");
    const loginWall = detectLoginWall({ finalUrl, html, title });
    if (loginWall.detected) {
      report.wall = "auth";
      report.phase_trace.push({ phase: "B_apply_click", outcome: "login wall" });
      return persist(report);
    }
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

    report.wall = "budget";
    report.phase_trace.push({
      phase: "B_apply_click",
      outcome: "unresolved (agent phase lands in N3)",
    });
    return persist(report);
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
    writeJsonAtomic(
      outPath,
      redactObject({
        ...r,
        written_at: new Date().toISOString(),
      } as unknown as Record<string, unknown>),
    );
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
      },
    });
    return r;
  }
}
