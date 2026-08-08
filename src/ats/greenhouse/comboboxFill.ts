import type { Locator, Page } from "playwright";

/**
 * Phase 5.6 live finding: Greenhouse job-boards renders selects as
 * React-select-style comboboxes. `.fill()` on them types filter text into
 * the inner input without ever committing an option — the UI keeps showing
 * "Select..." while inputValue() lies that something was entered. This
 * module opens, filters, picks a REAL option from the rendered list, and
 * confirms commitment from the visible display. Values are never invented:
 * no matching option means no selection plus a loud error.
 *
 * Live job-boards quirks handled here:
 * - Country options look like "United States +1"; display may collapse to "+1"
 * - Degree taxonomy uses "Bachelor's Degree" not "Bachelor of Science"
 * - Async / virtualized menus need sequential typing, not a single fill()
 */

export type ControlKind = "native_select" | "combobox" | "text";

export type ComboboxFillResult = {
  committed: boolean;
  selectedLabel: string | null;
  notes: string[];
  /** First visible options at pick time (training signal). */
  optionsSample?: string[];
  /** How the option was matched: exact | synonym | unique_substring | ci_exact */
  pickVia?: string | null;
};

export type OptionPick =
  | { ok: true; label: string; via: "exact" | "ci_exact" | "unique_substring" | "synonym" }
  | { ok: false; reason: string };

const PLACEHOLDER_RE = /^select\.{0,3}…?$|^select…$|^select\.\.\.$/i;

/** "United States +1" → "united states" */
export function stripDialCode(s: string): string {
  return s.replace(/\s*\+\d+\s*$/u, "").trim();
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Loose key for synonym / degree / punctuation-insensitive compare. */
function optionKey(s: string): string {
  return normalize(stripDialCode(s))
    .replace(/['']/g, "")
    .replace(/[^a-z0-9&+]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Known education vocabulary on Greenhouse job-boards. Profile strings are
 * often "Bachelor of Science"; options are "Bachelor's Degree".
 */
const DEGREE_BUCKETS: ReadonlyArray<readonly string[]> = [
  ["associate", "associates degree", "associate's degree"],
  [
    "bachelor",
    "bachelors",
    "bachelors degree",
    "bachelor degree",
    "bachelor of science",
    "bachelor of arts",
    "bachelor of engineering",
    "bs",
    "ba",
    "bsc",
    "b eng",
  ],
  [
    "master",
    "masters",
    "masters degree",
    "master degree",
    "master of science",
    "master of arts",
    "mba",
    "ms",
    "ma",
    "msc",
  ],
  ["phd", "ph d", "doctor of philosophy", "doctorate"],
  ["jd", "juris doctor", "j d"],
  ["md", "doctor of medicine", "m d"],
  ["high school", "secondary"],
];

function degreeBucket(key: string): number {
  const padded = ` ${key} `;
  for (let i = 0; i < DEGREE_BUCKETS.length; i++) {
    const bucket = DEGREE_BUCKETS[i]!;
    if (
      bucket.some((b) => {
        // Whole-token / whole-phrase match only — short codes like "ma"/"ms"/"bs"
        // must not fire inside "math" / "stats".
        if (b.length <= 3) {
          return padded.includes(` ${b} `) || key === b;
        }
        return key === b || key.includes(b) || b.includes(key);
      })
    ) {
      return i;
    }
  }
  return -1;
}

/** Entire-string yes/no only (profile short values + binary options). */
function yesNoToken(v: string): "yes" | "no" | null {
  const n = normalize(v);
  if (["yes", "y", "true", "1"].includes(n)) return "yes";
  if (["no", "n", "false", "0"].includes(n)) return "no";
  return null;
}

/**
 * Leading yes/no for long EEO/OFCCP sentences:
 * "No, I do not have a disability…" → no
 * "Yes, I have a disability…" → yes
 * "I do not want to answer" does not lead with yes/no → null
 */
function leadingYesNo(v: string): "yes" | "no" | null {
  const n = normalize(v);
  if (/^yes\b/.test(n)) return "yes";
  if (/^no\b/.test(n)) return "no";
  return null;
}

/** Decline / prefer-not-to-answer — never map bare Yes/No onto these. */
function isDeclineOption(v: string): boolean {
  const k = optionKey(v);
  return (
    /decline|prefer not|prefer not to say|do not want to answer|dont want to answer|i do not want|i dont want|not answer|do not wish|dont wish|i do not wish|i dont wish/.test(
      k,
    ) &&
    // Keep disability "No, I do not have a disability…" out of decline.
    !/\bhave a disability\b|\bhad a disability\b|\bhave not had one\b|\bdo not have a disability\b/.test(
      k,
    )
  );
}

/**
 * Match bare Yes/No to short options or long sentence options that *start*
 * with Yes/No (word boundary). Never attaches No → "I do not want…" via
 * substring ("not" contains "no").
 */
function pickYesNoOption(
  options: string[],
  expYn: "yes" | "no",
): OptionPick | null {
  const candidates = options.filter((o) => {
    if (isDeclineOption(o)) return false;
    if (yesNoToken(o) === expYn) return true;
    if (leadingYesNo(o) === expYn) return true;
    const k = optionKey(o);
    // OFCCP veteran (does not lead with Yes/No):
    // "I am not a protected veteran" / "I identify as one or more … protected veteran"
    if (expYn === "no" && /not a protected veteran|i am not a protected veteran/.test(k)) {
      return true;
    }
    if (
      expYn === "yes" &&
      /protected veteran/.test(k) &&
      !/not a protected veteran/.test(k) &&
      (/i identify as|i am a|classifications of a protected/.test(k) ||
        leadingYesNo(o) === "yes")
    ) {
      return true;
    }
    return false;
  });
  if (candidates.length === 1 && candidates[0] !== undefined) {
    return { ok: true, label: candidates[0], via: "synonym" };
  }
  if (candidates.length > 1) {
    // Prefer short binary label when present, else first leading-yes/no
    // sentence (OFCCP disability "No, I do not have…").
    const bare = candidates.find((o) => yesNoToken(o) === expYn);
    if (bare) return { ok: true, label: bare, via: "ci_exact" };
    // Prefer disability / veteran "No, …" / "Yes, …" over other long hits.
    const ofccpish = candidates.find((o) =>
      /disability|veteran|protected|armed forces/i.test(o),
    );
    if (ofccpish) return { ok: true, label: ofccpish, via: "synonym" };
    return {
      ok: false,
      reason: `ambiguous yes/no match for "${expYn}": ${candidates.slice(0, 5).join(" | ")}`,
    };
  }
  return null;
}

/** Word-boundary containment — blocks "no" ⊂ "not". */
function containsAsWord(haystack: string, needle: string): boolean {
  if (needle.length === 0 || haystack.length === 0) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(haystack);
}

/**
 * Pure option matching: exact → case-insensitive exact → dial-stripped →
 * degree synonym → yes/no (word-leading) → unique substring (either direction).
 * Values are never invented: multi-hit substring refuses.
 */
export function pickOptionLabel(options: string[], expected: string): OptionPick {
  const exp = expected.trim();
  if (exp === "") return { ok: false, reason: "expected value is empty" };

  // Operator rule: any math-ish major/discipline → prefer bare "Mathematics"
  // over compound "Applied Mathematics & Statistics" / "Applied Math & Stats"
  // when the board offers both (or only Mathematics).
  if (/\bmath/i.test(exp)) {
    const bareMath = options.find((o) => {
      const k = optionKey(o);
      return k === "mathematics" || normalize(o) === "mathematics";
    });
    if (bareMath) return { ok: true, label: bareMath, via: "synonym" };
  }

  const exact = options.find((o) => o.trim() === exp);
  if (exact) return { ok: true, label: exact, via: "exact" };

  const ciExact = options.filter((o) => normalize(o) === normalize(exp));
  if (ciExact.length === 1 && ciExact[0] !== undefined) {
    return { ok: true, label: ciExact[0], via: "ci_exact" };
  }

  // Country / phone-style labels: "United States" ↔ "United States +1"
  const strippedExp = optionKey(exp);

  // OFCCP veteran: profile "I am not a protected veteran" (or close) → board copy.
  // Boards phrase the negative answer with or without "protected"; match either,
  // but ONLY negative-polarity options — never an "I identify as…" row.
  if (
    /not a protected veteran|i am not a protected veteran|not a veteran/.test(
      strippedExp,
    )
  ) {
    const vetHits = options.filter((o) => {
      if (isDeclineOption(o)) return false;
      const k = optionKey(o);
      return /not\s+a(?:\s+protected)?\s+veteran/.test(k);
    });
    if (vetHits.length === 1 && vetHits[0] !== undefined) {
      return { ok: true, label: vetHits[0], via: "synonym" };
    }
    if (vetHits.length > 1) {
      const prefer = vetHits.find((o) =>
        /i am not a protected veteran/i.test(o),
      );
      if (prefer) return { ok: true, label: prefer, via: "synonym" };
    }
  }

  const dialHits = options.filter((o) => optionKey(o) === strippedExp);
  if (dialHits.length === 1 && dialHits[0] !== undefined) {
    return { ok: true, label: dialHits[0], via: "ci_exact" };
  }
  // country dial substrings: optionKey compare already handled as dialHits.
  // Keep dial-stripped unique substring here too (tight length gate):
  const dialSub = options.filter((o) => {
      const ok = optionKey(o);
      return (
        ok.length > 0 &&
        (ok.includes(strippedExp) ||
          (strippedExp.includes(ok) &&
            ok.length >= Math.max(10, Math.floor(strippedExp.length * 0.6))))
      );
    });
  if (dialSub.length === 1 && dialSub[0] !== undefined && strippedExp.length >= 3) {
    return { ok: true, label: dialSub[0], via: "unique_substring" };
  }

  const expBucket = degreeBucket(strippedExp);
  if (expBucket >= 0) {
    const degHits = options.filter((o) => degreeBucket(optionKey(o)) === expBucket);
    if (degHits.length === 1 && degHits[0] !== undefined) {
      return { ok: true, label: degHits[0], via: "synonym" };
    }
    // Prefer bare "Bachelor's Degree" over longer specialized degrees when many.
    if (degHits.length > 1) {
      const prefer = degHits.find((o) =>
        /bachelor'?s degree|master'?s degree|associate'?s degree/i.test(o),
      );
      if (prefer) return { ok: true, label: prefer, via: "synonym" };
    }
  }

  const expYn = yesNoToken(exp);
  if (expYn) {
    const ynPick = pickYesNoOption(options, expYn);
    if (ynPick) {
      if (ynPick.ok) return ynPick;
      // Ambiguous yes/no evidence — do not fall through to substring that
      // would re-match "not" on decline lines.
      return ynPick;
    }
  }

  // Gender vocabulary: operator "Man"/"Woman" ↔ board "Male"/"Female".
  // Identity boards keep Man/Woman; binary Sex select uses Male/Female.
  const genderMap: Record<string, string[]> = {
    man: ["man", "male", "m"],
    male: ["male", "man", "m"],
    woman: ["woman", "female", "f"],
    female: ["female", "woman", "f"],
    "non-binary": ["non-binary", "nonbinary", "non binary"],
    nonbinary: ["non-binary", "nonbinary", "non binary"],
  };
  const gKey = strippedExp;
  const gSyns = genderMap[gKey];
  if (gSyns) {
    // Prefer exact token match for identity ("Man") vs binary ("Male").
    const preferExact = options.filter((o) => optionKey(o) === gKey);
    if (preferExact.length === 1 && preferExact[0] !== undefined) {
      return { ok: true, label: preferExact[0], via: "synonym" };
    }
    const hits = options.filter((o) => {
      const ok = optionKey(o);
      return gSyns.some((s) => ok === s || ok.startsWith(s + " "));
    });
    if (hits.length === 1 && hits[0] !== undefined) {
      return { ok: true, label: hits[0], via: "synonym" };
    }
  }

  // Orientation: Heterosexual ↔ "Heterosexual or straight"
  if (
    strippedExp === "heterosexual" ||
    strippedExp === "straight" ||
    strippedExp === "heterosexual or straight"
  ) {
    const hits = options.filter((o) => {
      const ok = optionKey(o);
      return (
        ok === "heterosexual" ||
        ok === "straight" ||
        ok.includes("heterosexual") ||
        ok.includes("straight")
      );
    });
    if (hits.length === 1 && hits[0] !== undefined) {
      return { ok: true, label: hits[0], via: "synonym" };
    }
  }

  // Race: profile "Asian" — pick bare "Asian" or a single non-Hispanic Asian option.
  if (strippedExp === "asian") {
    const exact = options.find((o) => optionKey(o) === "asian");
    if (exact) return { ok: true, label: exact, via: "exact" };
    const asianHits = options.filter(
      (o) => /\basian\b/i.test(o) && !/hispanic|latino|latinx/i.test(o),
    );
    if (asianHits.length === 1 && asianHits[0] !== undefined) {
      return { ok: true, label: asianHits[0], via: "synonym" };
    }
    // Prefer "South Asian" / "East Asian" only when that is the sole remaining hit
    // class — never multi-pick Hispanic.
    if (asianHits.length > 1) {
      const prefer = asianHits.find((o) => /^asian$/i.test(o.trim()));
      if (prefer) return { ok: true, label: prefer, via: "synonym" };
    }
  }

  // Decline / prefer-not-to-say vocabulary (EEO questions).
  const declineRe =
    /decline|prefer not|do not wish|don t wish|dont wish|not answer|prefer not to say|i don t wish|i do not wish/;
  if (declineRe.test(strippedExp)) {
    const hits = options.filter((o) => declineRe.test(optionKey(o)));
    if (hits.length === 1 && hits[0] !== undefined) {
      return { ok: true, label: hits[0], via: "synonym" };
    }
    if (hits.length > 1) {
      const prefer = hits.find((o) => /decline/i.test(o));
      if (prefer) return { ok: true, label: prefer, via: "synonym" };
    }
  }

  const sub = options.filter((o) => {
    const ok = optionKey(o);
    if (ok.length < 2 || strippedExp.length < 2) return false;
    // Short tokens (yes/no/us) must be whole words — "no" must not hit "not".
    if (strippedExp.length <= 3) {
      return containsAsWord(ok, strippedExp);
    }
    // Prefer option that contains expected (filter refinements).
    if (ok.includes(strippedExp)) return true;
    // expected contains option only when the option is substantial —
    // blocks "Mathematics" from swallowing "Applied Mathematics".
    if (
      strippedExp.includes(ok) &&
      ok.length >= Math.max(10, Math.floor(strippedExp.length * 0.6))
    ) {
      return true;
    }
    return false;
  });
  if (sub.length === 1 && sub[0] !== undefined) {
    return { ok: true, label: sub[0], via: "unique_substring" };
  }
  if (sub.length > 1) {
    return {
      ok: false,
      reason: `ambiguous match for "${exp}": ${sub.slice(0, 5).join(" | ")}`,
    };
  }

  // Token overlap (discipline / school nicknames): "Applied Math & Stats"
  // may not exist on the GH board — prefer "Mathematics" / "Statistics…" over
  // a weak "Applied Health Services" hit.
  const tokens = strippedExp
    .split(/\s+/)
    .map((t) => t.replace(/&/g, "").trim())
    .filter((t) => t.length >= 3 && !["and", "the", "for", "of"].includes(t))
    .map((t) => {
      if (t === "stats" || t === "stat") return "statistic";
      if (t === "math" || t === "maths") return "math";
      if (t === "comp" || t === "cs") return "computer";
      return t;
    });
  if (tokens.length >= 1) {
    const scored = options
      .map((o) => {
        const ok = optionKey(o);
        let score = 0;
        for (const t of tokens) {
          if (ok.includes(t)) score += 1;
          else if (t === "math" && ok.includes("mathematic")) score += 3;
          else if (t === "statistic" && ok.includes("statistic")) score += 3;
          else if (t === "computer" && ok.includes("computer")) score += 3;
        }
        // Downgrade generic "applied …" matches that only hit "applied"
        if (
          score === 1 &&
          tokens.includes("applied") &&
          ok.startsWith("applied") &&
          !ok.includes("math") &&
          !ok.includes("stat")
        ) {
          score = 0;
        }
        return { o, score };
      })
      .filter((x) => x.score >= 1);
    scored.sort((a, b) => b.score - a.score);
    if (
      scored.length >= 1 &&
      scored[0] !== undefined &&
      (scored.length === 1 || scored[0].score > (scored[1]?.score ?? 0))
    ) {
      return { ok: true, label: scored[0].o, via: "unique_substring" };
    }
  }

  return {
    ok: false,
    reason: `no option matches "${exp}" (options: ${options.slice(0, 8).join(" | ")}${options.length > 8 ? " | …" : ""})`,
  };
}

/**
 * Whether the visible committed label matches the option we clicked.
 * Handles Greenhouse country UI collapsing "United States +1" → "+1".
 *
 * Note: bare +1 is shared by US/Canada/etc. We only accept dial-only
 * display against a *country name* when the pick/label text included that
 * dial (p.includes("+1")) — profile "United States" alone does not match
 * "+1"; verify must use a richer committed label or the dial must be
 * carried in the expected side (see valuesMatch phone/country helpers).
 */
export function labelsCompatible(
  pickedLabel: string,
  display: string | null,
): boolean {
  if (display === null) return false;
  const d = display.replace(/\s+/g, " ").trim();
  if (d === "" || PLACEHOLDER_RE.test(d)) return false;

  const p = pickedLabel.replace(/\s+/g, " ").trim();
  if (p === "") return false;
  if (normalize(p) === normalize(d)) return true;

  // Never treat empty substring as a match — "".includes is always true.
  const np = normalize(p);
  const nd = normalize(d);
  if (np.length >= 2 && nd.length >= 2 && (np.includes(nd) || nd.includes(np))) {
    return true;
  }

  const op = optionKey(p);
  const od = optionKey(d);
  if (op.length === 0 || od.length === 0) {
    // optionKey("+1") is empty after dial-strip; still allow collapse
    // when the picked option string clearly carried that dial.
    if (/^\+\d+$/.test(d) && p.includes(d)) return true;
    return false;
  }
  if (op === od) return true;
  if (op.length >= 2 && od.length >= 2 && (op.includes(od) || od.includes(op))) {
    return true;
  }
  // Dial-code-only display after picking "Country +N"
  if (/^\+\d+$/.test(d) && p.includes(d)) return true;
  return false;
}

/**
 * Classify the live control. Role/aria evidence first; hashed-class
 * fallbacks (React-select "select__control", select2) are last because
 * Greenhouse's CSS-module names churn.
 */
export async function detectControlKind(loc: Locator): Promise<ControlKind> {
  return loc.evaluate((el: {
    tagName: string;
    getAttribute: (n: string) => string | null;
    closest: (s: string) => unknown;
  }) => {
    if (el.tagName === "SELECT") return "native_select" as const;
    const role = el.getAttribute("role") ?? "";
    const haspopup = el.getAttribute("aria-haspopup") ?? "";
    const autocomplete = el.getAttribute("aria-autocomplete") ?? "";
    if (
      role === "combobox" ||
      haspopup === "listbox" ||
      haspopup === "true" ||
      autocomplete === "list" ||
      autocomplete === "both"
    ) {
      return "combobox" as const;
    }
    if (
      el.closest('[class*="select__control"]') ||
      el.closest('[class*="select-shell"]') ||
      el.closest('[class*="select2"]') ||
      el.closest('[role="combobox"]')
    ) {
      return "combobox" as const;
    }
    return "text" as const;
  });
}

/** Committed display text, or null while the placeholder is showing. */
export async function readComboboxValue(loc: Locator): Promise<string | null> {
  type ContainerEl = {
    querySelector: (s: string) => {
      textContent: string | null;
      getAttribute?: (n: string) => string | null;
      childNodes?: ArrayLike<{ textContent?: string | null; nodeType?: number }>;
    } | null;
    querySelectorAll: (s: string) => ArrayLike<{ textContent: string | null }>;
    textContent: string | null;
    closest: (s: string) => ContainerEl | null;
  };
  const raw = await loc.evaluate((el: ContainerEl) => {
    const shell =
      el.closest('[class*="select-shell"]') ??
      el.closest('[class*="select__control"]') ??
      el.closest('[class*="select_"]');
    if (!shell) return null;

    // ONLY the single-value node counts as committed — never the open menu or
    // the filter input. Using control textContent caused false positives when
    // the menu listed matching options while still on Select...
    const single = shell.querySelector(
      '[class*="single-value"], [class*="singleValue"]',
    );
    if (single) {
      const t = (single.textContent || "").replace(/\s+/g, " ").trim();
      if (t) return t;
      const title = single.getAttribute?.("title");
      if (title) return title;
    }

    // Multi-select chips: only label nodes (parent multi-value doubles text).
    const multi = shell.querySelectorAll(
      '[class*="multi-value__label"], [class*="multiValue__label"]',
    );
    const chips: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < multi.length; i++) {
      const t = (multi[i]?.textContent || "").replace(/\s+/g, " ").trim();
      if (t && t !== "×" && t !== "x" && t.length > 1 && !seen.has(t)) {
        seen.add(t);
        chips.push(t);
      }
    }
    if (chips.length > 0) {
      return chips.join(", ");
    }
    return null;
  });
  if (raw === null) return null;
  const text = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^select\.{0,3}…?\s*/i, "")
    .replace(/\s*select\.{0,3}…?$/i, "")
    .trim();
  if (text === "" || PLACEHOLDER_RE.test(text)) return null;
  return text;
}

const LISTBOX_SELECTOR = '[role="listbox"], [class*="select__menu"]';
const OPTION_SELECTOR = '[role="option"], [class*="select__option"]';

/**
 * True for Stats / Statistics majors — not for "United States" (/\bstat/ matches
 * the prefix of "states").
 */
function hasStatsMajorToken(lower: string): boolean {
  return /\bstats?\b|\bstatistics\b|\bstatistical\b/.test(lower);
}

/** Progressive filter strings for virtualized React-select menus. */
export function buildFilterCandidates(expected: string): string[] {
  const full = expected.trim();
  if (full === "") return [];
  const cleaned = full
    .replace(/[&|,/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = cleaned.split(" ").filter((w) => w.length > 0);
  const out: string[] = [];
  const push = (s: string) => {
    const t = s.trim().slice(0, 40);
    if (t && !out.includes(t)) out.push(t);
  };
  const lower = cleaned.toLowerCase();

  // Degree: type "Bachelor" / "Master" first — GH job-boards catalogue
  // is usually "Bachelor's Degree", not "Bachelor of Science". Full
  // profile strings still remain as later fallbacks.
  if (/\bbachelor/.test(lower)) {
    push("Bachelor");
    push("Bachelor's Degree");
  } else if (/\bmba\b/.test(lower)) {
    push("MBA");
  } else if (/\bmaster/.test(lower)) {
    push("Master");
    push("Master's Degree");
  } else if (/\bassociate/.test(lower)) {
    push("Associate");
    push("Associate's Degree");
  } else if (/\bph\.?\s*d|doctorate|doctor of philosophy/.test(lower)) {
    push("PhD");
    push("Doctor");
  }

  // Math majors: always filter "Mathematics" first, then applied/composite strings.
  // Live GH boards almost never list "Applied Math & Stats" as a catalogue option.
  if (/\bmath/.test(lower)) {
    push("Mathematics");
    push("Math");
  }
  // Must NOT use /\bstat/ — it matches "States" in "United States" and
  // briefly types "Statistics" into country comboboxes before correcting.
  if (hasStatsMajorToken(lower) && !/\bmath/.test(lower)) {
    push("Statistics");
  }

  push(full);
  push(cleaned);
  if (words.length >= 3) push(words.slice(0, 3).join(" "));
  if (words.length >= 2) push(words.slice(0, 2).join(" "));
  // Skip leading "Applied" as first token for math majors — already tried Math.
  if (words.length >= 1 && words[0]!.toLowerCase() !== "applied") {
    push(words[0]!);
  } else if (words.length >= 2) {
    push(words[1]!);
  }
  if (hasStatsMajorToken(lower)) {
    push("Statistics");
  }
  if (/\bcomputer|\bcs\b/.test(lower)) {
    push("Computer Science");
    push("Computer");
  }
  // Remaining content words (skip filler)
  for (const w of words) {
    if (
      w.length >= 4 &&
      !["applied", "science", "studies", "with"].includes(w.toLowerCase())
    ) {
      push(w);
    }
  }
  return out;
}

async function clearComboboxSelection(
  page: Page,
  clickTarget: Locator,
): Promise<string[]> {
  const notes: string[] = [];
  // Clear-all control wipes every multi/single chip in one click.
  const clearAll = clickTarget
    .locator(
      '[class*="clear-indicator"], [class*="ClearIndicator"], [aria-label*="Clear" i]',
    )
    .first();
  if ((await clearAll.count().catch(() => 0)) > 0) {
    await clearAll.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    notes.push("cleared selection via clear-indicator");
    await page.waitForTimeout(100);
    return notes;
  }
  // Multi-value remove (×) on each chip — remove until gone (cap 12).
  for (let i = 0; i < 12; i++) {
    const remove = clickTarget
      .locator(
        '[class*="multi-value__remove"], [class*="multiValue__remove"], [aria-label*="Remove" i]',
      )
      .first();
    if ((await remove.count().catch(() => 0)) === 0) break;
    await remove.click({ force: true, timeout: 1_500 }).catch(() => undefined);
    notes.push("removed multi-value chip");
    await page.waitForTimeout(80);
  }
  return notes;
}

async function openCombobox(
  page: Page,
  loc: Locator,
): Promise<{ clickTarget: Locator; notes: string[] }> {
  const notes: string[] = [];
  const control = loc
    .locator(
      'xpath=ancestor-or-self::*[contains(@class,"select__control") or contains(@class,"select-shell") or @role="combobox"][1]',
    )
    .first();
  const clickTarget = (await control.count()) > 0 ? control : loc;
  await clickTarget.scrollIntoViewIfNeeded().catch(() => undefined);

  // Wipe prior chips/selection first — Greenhouse multi-selects *append*.
  // Without this you get Non-binary+Man, East Asian+Hispanic, Glassdoor+LinkedIn.
  notes.push(...(await clearComboboxSelection(page, clickTarget)));

  // force: inner input is often 3×20; the control div is the real hit target.
  // Single click only — do not Escape/re-click while the menu is opening.
  await clickTarget.click({ timeout: 10_000, force: true });
  notes.push("opened via control click");
  await page.waitForTimeout(200);
  return { clickTarget, notes };
}

/**
 * Open → (filter) → pick a real option → confirm commitment.
 * Returns committed:false with notes rather than leaving filter residue —
 * the caller records an error and the field stays honestly unfilled.
 */
export async function fillComboboxControl(
  page: Page,
  loc: Locator,
  expected: unknown,
): Promise<ComboboxFillResult> {
  const notes: string[] = [];
  const expectedText = String(expected);

  const opened = await openCombobox(page, loc);
  notes.push(...opened.notes);

  // Multiple menus exist in the DOM (one per combobox); only the one just
  // opened is visible — scope everything to visible elements.
  const listbox = page
    .locator(LISTBOX_SELECTOR)
    .filter({ visible: true })
    .first();
  try {
    await listbox.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    notes.push("listbox did not open after click");
    return { committed: false, selectedLabel: null, notes };
  }

  const collectOptions = async (): Promise<string[]> =>
    (
      await page
        .locator(OPTION_SELECTOR)
        .filter({ visible: true })
        .allTextContents()
    )
      .map((t) => t.replace(/\s+/g, " ").trim())
      .filter((t) => t.length > 0);

  // Filter with sequential typing — React-select often ignores a single fill()
  // and virtualized menus only expose matching rows after the filter settles.
  // Progressive filters: full string → strip punctuation → head tokens.
  let options: string[] = [];
  const filterCandidates = buildFilterCandidates(expectedText);
  try {
    await loc.click({ force: true, timeout: 3_000 }).catch(() => undefined);
    for (const typeText of filterCandidates) {
      // Clear prior filter without collapsing the menu when possible.
      await loc.evaluate((el: { focus: () => void; value: string }) => {
        el.focus();
        el.value = "";
      }).catch(() => undefined);
      // keyboard.type reaches React onZero-size combobox inputs more reliably than fill().
      await page.keyboard.type(typeText, { delay: 25 });
      options = [];
      for (let i = 0; i < 18; i++) {
        await page.waitForTimeout(120);
        options = await collectOptions();
        if (options.length === 0) continue;
        if (pickOptionLabel(options, expectedText).ok) break;
      }
      if (pickOptionLabel(options, expectedText).ok) {
        notes.push(
          `filter "${typeText}" → ${options.length} option(s); match`,
        );
        break;
      }
    }
    if (options.length === 0 || !pickOptionLabel(options, expectedText).ok) {
      // Re-open and dump unfiltered (first virtualization window).
      await page.keyboard.press("Escape").catch(() => undefined);
      await openCombobox(page, loc);
      await listbox.waitFor({ state: "visible", timeout: 3_000 }).catch(() => undefined);
      await page.waitForTimeout(250);
      options = await collectOptions();
      notes.push("filter yielded no/unmatched options; re-collected unfiltered");
    }
  } catch {
    options = await collectOptions();
    notes.push("control not typeable; using unfiltered options");
  }

  const pick = pickOptionLabel(options, expectedText);
  const optionsSample = options.slice(0, 20);
  if (!pick.ok) {
    notes.push(pick.reason);
    await page.keyboard.press("Escape").catch(() => undefined);
    await loc.fill("").catch(() => undefined);
    return {
      committed: false,
      selectedLabel: null,
      notes,
      optionsSample,
      pickVia: null,
    };
  }

  // Prefer role=option exact text when Playwright can resolve it; fall back to
  // substring filter if whitespace / flag chrome differs.
  const optionByRole = page.getByRole("option", { name: pick.label, exact: true });
  let option = optionByRole.filter({ visible: true }).first();
  if ((await option.count().catch(() => 0)) === 0) {
    option = page
      .locator(OPTION_SELECTOR)
      .filter({ visible: true })
      .filter({ hasText: pick.label })
      .first();
  }
  await option.click({ timeout: 5_000, force: true });
  notes.push(`picked "${pick.label}" (${pick.via})`);

  await listbox
    .waitFor({ state: "hidden", timeout: 5_000 })
    .catch(async () => {
      notes.push("listbox still visible after pick");
      // Multi-select keeps the menu open; Escape commits chips and blurs filter.
      await page.keyboard.press("Escape").catch(() => undefined);
    });
  // Always close residual filter focus so the next field isn't left typing residue.
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(250);

  // Re-read after menu settles (multi-value chips mount after close).
  let committedLabel = await readComboboxValue(loc);
  if (!committedLabel) {
    await page.waitForTimeout(300);
    committedLabel = await readComboboxValue(loc);
  }
  let committed = labelsCompatible(pick.label, committedLabel);
  // Multi-select chips may report "LinkedIn, Other" while pick was "LinkedIn".
  // Require the pick to appear AND refuse when unexpected second chips remain
  // for a single-value expectation (operator fills one answer at a time).
  if (
    !committed &&
    committedLabel &&
    normalize(committedLabel).includes(normalize(pick.label))
  ) {
    const parts = committedLabel.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length <= 1 || parts.every((p) => labelsCompatible(pick.label, p) || normalize(p) === normalize(pick.label))) {
      committed = true;
      notes.push(`multi-select chip contains "${pick.label}"`);
    } else {
      notes.push(
        `multi residue after clear: display shows "${committedLabel}" (wanted only "${pick.label}")`,
      );
    }
  }
  if (!committed) {
    notes.push(
      `commit not confirmed: display shows ${committedLabel === null ? "placeholder" : `"${committedLabel}"`}`,
    );
  }
  // Prefer the richer option label over dial-code-only collapse ("+1").
  let selectedLabel = committedLabel;
  if (committed && committedLabel && /^\+\d+$/.test(committedLabel.trim())) {
    selectedLabel = stripDialCode(pick.label) || pick.label;
    notes.push(`display collapsed to dial code; recording "${selectedLabel}"`);
  } else if (committed && !committedLabel) {
    selectedLabel = stripDialCode(pick.label) || pick.label;
  } else if (committed && committedLabel) {
    selectedLabel = committedLabel;
  }
  return {
    committed,
    selectedLabel: committed ? selectedLabel : null,
    notes,
    optionsSample,
    pickVia: pick.via,
  };
}
