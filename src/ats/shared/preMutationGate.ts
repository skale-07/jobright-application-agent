import type { Page } from "playwright";
import { detectBlockingCaptcha } from "../greenhouse/captchaDetection.js";
import { detectLoginWall } from "../greenhouse/loginWallDetection.js";
import { discoverFieldsFromHtml } from "../../applications/fieldDiscovery.js";

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

export async function verifyPageBeforeMutationGeneric(
  page: Page,
  options: {
    isTrustedHost: (url: string) => boolean;
    formMarkers: RegExp;
  },
): Promise<GenericPreMutationGateResult> {
  const finalUrl = page.url();
  const html = await page.content();
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
  const loginWall = detectLoginWall({ finalUrl, html, title });
  if (loginWall.detected) {
    return fail("LOGIN_WALL", `login wall detected: ${loginWall.signals.join(",")}`);
  }
  const formDetected = options.formMarkers.test(html);
  const captcha = detectBlockingCaptcha({
    finalUrl,
    html,
    title,
    formDetected,
    fieldCount: discoverFieldsFromHtml(html).length,
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
  return { ok: true, finalUrl, html, title, failureCode: null, reason: null };
}
