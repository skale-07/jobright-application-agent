import type { Page } from "playwright";
import { discoverFieldsFromHtml } from "../../applications/fieldDiscovery.js";
import { isLoopbackUrl } from "../generic/urlValidation.js";

/**
 * Iframe-hosted application forms.
 *
 * `page.content()` NEVER includes iframe content, and the fill path has no
 * frameLocator — so a company page embedding its form in an iframe
 * (Greenhouse embeds, Paycom-style portals) discovered ZERO fields and
 * refused NO_APPLICATION_FORM while a human plainly saw a form.
 *
 * The hop converts the iframe problem into the already-solved page
 * problem: find the child frame whose own document carries fillable
 * fields, and NAVIGATE the page to that frame's URL — embedded ATS forms
 * are standalone pages (a Greenhouse embed is a full page at
 * boards.greenhouse.io). Everything downstream (gate, plan, fill, verify,
 * submit) then runs against a normal top-level document.
 *
 * Read-only: this module only inspects frames; the caller does the goto
 * and re-gates, so every pre-mutation check runs again on the hopped page.
 */
export async function findApplicationFrameUrl(
  page: Page,
): Promise<{ url: string; fieldCount: number } | null> {
  let best: { url: string; fieldCount: number } | null = null;
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const url = frame.url();
    if (!isHopableFrameUrl(url)) continue;
    const html = await frame.content().catch(() => null);
    if (!html) continue;
    const fields = discoverFieldsFromHtml(html);
    if (fields.length === 0) continue;
    if (!best || fields.length > best.fieldCount) {
      best = { url, fieldCount: fields.length };
    }
  }
  return best;
}

/**
 * Live embeds are https. The operator sandbox is loopback http — the
 * same hop must see `/fillhard/embed` or the outer zero-field page
 * parks as UNKNOWN_LANDING. Arbitrary http frames stay ignored.
 */
function isHopableFrameUrl(url: string): boolean {
  if (!url || url === "about:blank") return false;
  if (url.startsWith("https://")) return true;
  return isLoopbackUrl(url);
}
