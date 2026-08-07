/**
 * Pure parsers for verification emails. Boring on purpose: regex + keyword
 * proximity, no LLM near code digits, null over guessing. The magic-link
 * extractor only accepts links on the sender's registrable domain (or an
 * explicit allowlist) so a marketing footer can never redirect navigation.
 */

const CODE_KEYWORDS =
  /\b(code|verification|verify|otp|pin|passcode|one[- ]time)\b/i;

/**
 * Extract a 4–8 digit OTP. Candidates are scored by proximity to a code
 * keyword (subject counts as adjacent); returns null when no candidate
 * sits near a keyword — a bare number in a footer is not a code.
 */
export function extractOtpCode(subject: string, body: string): string | null {
  const text = `${subject}\n${body}`;
  const candidates: Array<{ code: string; score: number }> = [];
  // Guards target decimals/longer runs ("1.2345", "12345678901") without
  // rejecting a code at sentence end ("...code is 482193.").
  const re = /(?<![\d.])(\d{4,8})(?!\d)(?!\.\d)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const code = m[1]!;
    const windowStart = Math.max(0, m.index - 80);
    const windowEnd = Math.min(text.length, m.index + code.length + 80);
    const context = text.slice(windowStart, windowEnd);
    // Keyword proximity is the qualifier; length is only a tiebreaker —
    // a bare 6-digit number in marketing copy is never a code.
    let keywordScore = 0;
    if (CODE_KEYWORDS.test(context)) keywordScore += 2;
    if (CODE_KEYWORDS.test(subject) && m.index < subject.length + 200) {
      keywordScore += 1;
    }
    if (keywordScore === 0) continue;
    const score = keywordScore + (code.length === 6 ? 1 : 0);
    candidates.push({ code, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.code ?? null;
}

/** Registrable-ish domain: last two labels (co.uk-style TLDs out of scope). */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().split(".").filter(Boolean);
  return labels.slice(-2).join(".");
}

/**
 * Extract the verification/magic link. Only https links whose host shares
 * the sender's registrable domain (or an entry in the allowlist) qualify;
 * verification-ish paths are preferred over bare homepage links.
 */
export function extractMagicLink(
  body: string,
  options: { senderAddress: string; extraAllowedDomains?: string[] },
): string | null {
  const senderHost = options.senderAddress.split("@")[1] ?? "";
  const allowed = new Set(
    [registrableDomain(senderHost), ...(options.extraAllowedDomains ?? [])]
      .map((d) => d.toLowerCase())
      .filter(Boolean),
  );
  if (allowed.size === 0) return null;

  const urls = body.match(/https:\/\/[^\s"'<>)\]]+/g) ?? [];
  const qualified: Array<{ url: string; score: number }> = [];
  for (const raw of urls) {
    const cleaned = raw.replace(/[.,;]+$/, "");
    let host: string;
    try {
      host = new URL(cleaned).hostname.toLowerCase();
    } catch {
      continue;
    }
    const domain = registrableDomain(host);
    if (!allowed.has(domain)) continue;
    let score = 1;
    if (/verify|confirm|magic|auth|token|activate|login/i.test(cleaned)) score += 2;
    if (/unsubscribe|preferences|privacy|terms/i.test(cleaned)) score -= 3;
    qualified.push({ url: cleaned, score });
  }
  qualified.sort((a, b) => b.score - a.score);
  const best = qualified[0];
  return best && best.score > 0 ? best.url : null;
}
