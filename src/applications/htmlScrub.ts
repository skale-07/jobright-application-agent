/**
 * Value-scrubbing for HTML snapshots that land in artifacts. One shared
 * implementation so no snapshot path can forget a rule: scripts dropped,
 * every value= attribute and textarea body replaced, size-capped.
 */
export function scrubHtmlForSnapshot(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/\bvalue\s*=\s*"[^"]*"/gi, 'value="[SCRUBBED]"')
    .replace(/\bvalue\s*=\s*'[^']*'/gi, "value='[SCRUBBED]'")
    .replace(/(<textarea\b[^>]*>)[\s\S]*?(<\/textarea>)/gi, "$1[SCRUBBED]$2")
    .slice(0, 2_000_000);
}
