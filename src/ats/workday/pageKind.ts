/**
 * Workday page-kind from HTML. Used after portal auth to decide whether
 * fill may plan, or the run is still on a posting/chooser/login wall.
 *
 * HTML-only: hidden wizard nodes in a mashed fixture can look like a
 * wizard. Live Crowe postings do not include My Information fields until
 * after Apply / sign-in.
 */
export type WorkdayPageKind =
  | "posting"
  | "chooser"
  | "auth"
  | "wizard"
  | "unknown";

export function classifyWorkdayPage(html: string): WorkdayPageKind {
  // Script/template text is not the page: an SPA's own bundle mentions
  // form markup as string literals (a sign-in template kept classifying
  // the POST-sign-in page as auth). Same strip fieldDiscovery does.
  const h = html
    .slice(0, 200_000)
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<template\b[\s\S]*?<\/template>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  // AUTH FIRST. Create Account / Sign In is step 1 OF the wizard and
  // renders the same progress bar as My Information — live 2026-08-14
  // (Crowe): the account form was classified "wizard", so the auth branch
  // never ran and the page parked as "nothing to fill". A page asking for
  // a password is an auth page whatever else is drawn around it; the
  // wizard's own steps never ask for one.
  if (
    /<input[^>]+type=["']password["']/i.test(h) ||
    /data-automation-id=["'](?:password|verifyPassword)["']/.test(h)
  ) {
    return "auth";
  }
  if (
    /data-automation-id=["']legalNameSection_firstName["']/.test(h) ||
    /data-automation-id=["']progressBar["']/.test(h)
  ) {
    return "wizard";
  }
  if (
    /data-automation-id=["']applyManually["']/.test(h) ||
    />\s*Apply Manually\s*</i.test(h)
  ) {
    return "chooser";
  }
  if (
    /data-automation-id=["']adventureButton["']/.test(h) ||
    /<(?:a|button)[^>]*>\s*Apply(?: now)?\s*</i.test(h)
  ) {
    return "posting";
  }
  return "unknown";
}
