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
  const h = html.slice(0, 200_000);
  if (
    /data-automation-id=["']legalNameSection_firstName["']/.test(h) ||
    /data-automation-id=["']progressBar["']/.test(h)
  ) {
    return "wizard";
  }
  if (
    /<input[^>]+type=["']password["']/i.test(h) ||
    /data-automation-id=["'](?:password|verifyPassword)["']/.test(h)
  ) {
    return "auth";
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
