import type { Page } from "playwright";
import { detectBlockingCaptcha } from "../greenhouse/captchaDetection.js";
import { detectLoginWall } from "../greenhouse/loginWallDetection.js";
import { discoverFieldsFromHtml } from "../../applications/fieldDiscovery.js";
import { classifyPage } from "./pageClassify.js";

/**
 * Generic pre-mutation page gate for ATSes without an identity-verification
 * equivalent. DELIBERATELY WEAKER than greenhouse's verifyPageBeforeMutation:
 * Lever/Ashby URLs carry no board-token/job-id pair to cross-check against
 * the rendered page, so this gate can only prove we are on a trusted host,
 * were not redirected off it, are not behind a login wall or blocking
 * CAPTCHA, and that an application form is actually present. The layered
 * defenses above it (flag gates, approved plan, verify-before-click, human
 * confirmation) are unchanged.
 */
export type GenericPreMutationGateResult = {
  ok: boolean;
  finalUrl: string;
  html: string;
  title: string;
  failureCode: string | null;
  reason: string | null;
};

/**
 * Poll page content until the marker matches or the deadline passes —
 * SPAs (Ashby) render the form well after domcontentloaded, so a single
 * immediate read would classify every live page as form-less. Bounded:
 * at most timeoutMs / intervalMs reads.
 */
export async function waitForRenderedContent(
  page: Page,
  marker: RegExp,
  timeoutMs = 10_000,
  intervalMs = 500,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let html = await page.content();
  while (!marker.test(html) && Date.now() < deadline) {
    await page.waitForTimeout(intervalMs);
    html = await page.content();
  }
  return html;
}

export async function verifyPageBeforeMutationGeneric(
  page: Page,
  options: {
    isTrustedHost: (url: string) => boolean;
    formMarkers: RegExp;
    /**
     * Validated posting URL. When set, the final pathname must match it —
     * a redirect to a different posting (closed job → board page, another
     * job's form) must not be filled. Weaker than greenhouse's identity
     * gate but preserves the same invariant the URL can carry.
     */
    expectedUrl?: string;
    renderTimeoutMs?: number;
  },
): Promise<GenericPreMutationGateResult> {
  const htmlImmediate = await page.content();
  // A listing page will never grow a <form> if we wait. Burning the SPA
  // render timeout here is what made /portal look like a hang before the
  // run refused NO_APPLICATION_FORM. Skip the wait when the first paint
  // is already a posting; unknown/empty first paints still wait.
  const html0 =
    classifyPage({ html: htmlImmediate, url: page.url() }).page_class ===
    "posting"
      ? htmlImmediate
      : await waitForRenderedContent(
          page,
          options.formMarkers,
          options.renderTimeoutMs ?? 10_000,
        );
  const finalUrl = page.url();
  const html = html0;
  const title = await page.title().catch(() => "");

  const fail = (
    failureCode: string,
    reason: string,
  ): GenericPreMutationGateResult => ({
    ok: false,
    finalUrl,
    html,
    title,
    failureCode,
    reason,
  });

  if (!options.isTrustedHost(finalUrl)) {
    return fail(
      "UNTRUSTED_FINAL_HOST",
      `navigation ended on an untrusted host: ${finalUrl}`,
    );
  }
  if (options.expectedUrl) {
    try {
      const finalPath = new URL(finalUrl).pathname.replace(/\/+$/, "");
      const expectedPath = new URL(options.expectedUrl).pathname.replace(
        /\/+$/,
        "",
      );
      if (finalPath !== expectedPath) {
        return fail(
          "POSTING_MISMATCH",
          `final path ${finalPath} is not the validated posting ${expectedPath} — redirected posting is never filled`,
        );
      }
    } catch {
      return fail("POSTING_MISMATCH", "final URL could not be parsed");
    }
  }
  const loginWall = detectLoginWall({ finalUrl, html, title });
  if (loginWall.detected) {
    return fail("LOGIN_WALL", `login wall detected: ${loginWall.signals.join(",")}`);
  }
  const formDetected = options.formMarkers.test(html);
  const discovered = discoverFieldsFromHtml(html);
  const captcha = detectBlockingCaptcha({
    finalUrl,
    html,
    title,
    formDetected,
    fieldCount: discovered.length,
  });
  if (captcha.detected) {
    return fail(
      "BLOCKING_CAPTCHA",
      `blocking CAPTCHA detected: ${captcha.signals.join(",")}`,
    );
  }
  if (!formDetected) {
    return fail(
      "NO_APPLICATION_FORM",
      "application form markers not found on the final page",
    );
  }
  // Markers are not enough. Live 2026-08-14 (Crowe, first Workday fill): a
  // POSTING page passed this gate because Workday stamps
  // data-automation-id on every page, so the fill "succeeded" with 0 fields
  // planned, 0 filled, and a verify failure that read like a selector bug
  // instead of "this is the job description, not the form". A form you
  // cannot type into is not a form, and a silent 0-field fill is worse than
  // a refusal — it burns an attempt and reports a failure nobody can
  // diagnose. Vendor-blind on purpose: every adapter shares this gate.
  if (discovered.length === 0) {
    return fail(
      "NO_APPLICATION_FORM",
      "form markers matched but the page has no fillable fields — this is a posting/description page, not the application form",
    );
  }
  return { ok: true, finalUrl, html, title, failureCode: null, reason: null };
}
