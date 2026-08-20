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

/** Country vocabulary differences between profiles and location autocompletes. */
const COUNTRY_SYNONYMS: Record<string, string> = {
  usa: "united states",
  us: "united states",
  "u s a": "united states",
  "united states of america": "united states",
  uk: "united kingdom",
};

/**
 * USPS name ↔ abbreviation. Paylocity (live 053aa25b) lists MD, not
 * Maryland. Matching only fires when the page actually offers one of the
 * pair — we never invent a code into an empty list.
 */
const US_STATE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["alabama", "al"],
  ["alaska", "ak"],
  ["arizona", "az"],
  ["arkansas", "ar"],
  ["california", "ca"],
  ["colorado", "co"],
  ["connecticut", "ct"],
  ["delaware", "de"],
  ["district of columbia", "dc"],
  ["florida", "fl"],
  ["georgia", "ga"],
  ["hawaii", "hi"],
  ["idaho", "id"],
  ["illinois", "il"],
  ["indiana", "in"],
  ["iowa", "ia"],
  ["kansas", "ks"],
  ["kentucky", "ky"],
  ["louisiana", "la"],
  ["maine", "me"],
  ["maryland", "md"],
  ["massachusetts", "ma"],
  ["michigan", "mi"],
  ["minnesota", "mn"],
  ["mississippi", "ms"],
  ["missouri", "mo"],
  ["montana", "mt"],
  ["nebraska", "ne"],
  ["nevada", "nv"],
  ["new hampshire", "nh"],
  ["new jersey", "nj"],
  ["new mexico", "nm"],
  ["new york", "ny"],
  ["north carolina", "nc"],
  ["north dakota", "nd"],
  ["ohio", "oh"],
  ["oklahoma", "ok"],
  ["oregon", "or"],
  ["pennsylvania", "pa"],
  ["rhode island", "ri"],
  ["south carolina", "sc"],
  ["south dakota", "sd"],
  ["tennessee", "tn"],
  ["texas", "tx"],
  ["utah", "ut"],
  ["vermont", "vt"],
  ["virginia", "va"],
  ["washington", "wa"],
  ["west virginia", "wv"],
  ["wisconsin", "wi"],
  ["wyoming", "wy"],
];

const US_STATE_ABBR: Record<string, string> = Object.fromEntries(US_STATE_PAIRS);
const US_STATE_NAME: Record<string, string> = Object.fromEntries(
  US_STATE_PAIRS.map(([name, abbr]) => [abbr, name]),
);

function usStateSynonyms(expectedKey: string): string[] | null {
  const abbr = US_STATE_ABBR[expectedKey];
  if (abbr) return [expectedKey, abbr];
  const name = US_STATE_NAME[expectedKey];
  if (name) return [expectedKey, name];
  return null;
}

function pickUsStateOption(
  options: string[],
  expected: string,
): OptionPick | null {
  const syns = usStateSynonyms(optionKey(expected));
  if (!syns) return null;
  const hits = options.filter((o) => syns.includes(optionKey(o)));
  if (hits.length === 0) return null;
  const prefer = hits.find((o) => optionKey(o) === optionKey(expected));
  return { ok: true, label: prefer ?? hits[0]!, via: "synonym" };
}

function locationParts(s: string): string[] {
  return s
    .split(",")
    .map((p) => optionKey(p))
    .filter((p) => p.length > 0)
    .map((p) => COUNTRY_SYNONYMS[p] ?? US_STATE_ABBR[p] ?? p);
}

/**
 * Comma-shaped location matching. Live failure (impact.com, cc02e067):
 * profile "Baltimore, Maryland, USA" vs board options "Baltimore, Maryland,
 * United States" plus near-ties ("Baltimore County, …", "Baltimore
 * Highlands, …") — token overlap ties and refuses. Compare comma parts
 * pairwise with country synonyms; among hits prefer the shortest label
 * (the bare city). Null when the expected value is not location-shaped.
 */
export function pickLocationOption(
  options: string[],
  expected: string,
): OptionPick | null {
  const expParts = locationParts(expected);
  if (expParts.length < 2) return null;
  const hits = options.filter((o) => {
    const parts = locationParts(o);
    if (parts.length === 0) return false;
    const n = Math.min(expParts.length, parts.length);
    for (let i = 0; i < n; i++) {
      if (expParts[i] !== parts[i]) return false;
    }
    return true;
  });
  if (hits.length === 0) return null;
  const sorted = [...hits].sort((a, b) => a.length - b.length);
  return { ok: true, label: sorted[0]!, via: "synonym" };
}

const MONTH_INDEX: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

const SEASON_WORD_RE = /\b(winter|spring|summer|fall|autumn)\b/;

function monthNumber(raw: string): number | null {
  const k = optionKey(raw);
  if (MONTH_INDEX[k] !== undefined) return MONTH_INDEX[k]!;
  const n = Number(k);
  if (Number.isInteger(n) && n >= 1 && n <= 12) return n;
  return null;
}

/** Academic-calendar seasons. May → spring; Jump's "Spring/Summer" matches spring. */
function seasonsForMonth(month: number): string[] {
  if (month === 12 || month <= 2) return ["winter"];
  if (month <= 5) return ["spring"];
  if (month <= 7) return ["summer"];
  return ["fall", "autumn"];
}

function parseYearMonthExpected(
  expected: string,
): { year: string; month: number | null } | null {
  const t = expected.trim();
  const yearOnly = t.match(/^(20\d{2}|19\d{2})$/);
  if (yearOnly?.[1]) return { year: yearOnly[1], month: null };
  const monthYear = t.match(/^([A-Za-z]+|\d{1,2})\s+(20\d{2}|19\d{2})$/);
  if (monthYear?.[1] && monthYear[2]) {
    return { year: monthYear[2], month: monthNumber(monthYear[1]) };
  }
  const yearMonth = t.match(/^(20\d{2}|19\d{2})\s+([A-Za-z]+|\d{1,2})$/);
  if (yearMonth?.[1] && yearMonth[2]) {
    return { year: yearMonth[1], month: monthNumber(yearMonth[2]) };
  }
  return null;
}

/**
 * Profile stores a year (and usually a month). Boards like Jump offer
 * "Winter 2029 | Spring/Summer 2029 | Fall 2029". A bare year is
 * ambiguous — refuse. Month + year that uniquely names one season is not.
 */
function pickSeasonalYearOption(
  options: string[],
  expected: string,
): OptionPick | null {
  const parsed = parseYearMonthExpected(expected);
  if (!parsed) return null;
  const yearHits = options.filter((o) => {
    const k = optionKey(o);
    return (
      containsAsWord(k, parsed.year) && SEASON_WORD_RE.test(k)
    );
  });
  if (yearHits.length === 0) return null;
  if (yearHits.length === 1 && yearHits[0] !== undefined) {
    return { ok: true, label: yearHits[0], via: "unique_substring" };
  }
  if (parsed.month === null) return null;
  const seasons = seasonsForMonth(parsed.month);
  const seasonHits = yearHits.filter((o) => {
    const k = optionKey(o);
    return seasons.some((s) => containsAsWord(k, s));
  });
  if (seasonHits.length === 1 && seasonHits[0] !== undefined) {
    return { ok: true, label: seasonHits[0], via: "synonym" };
  }
  return null;
}

/**
 * Pure option matching: exact → case-insensitive exact → dial-stripped →
 * location parts → degree synonym → yes/no (word-leading) → unique
 * substring (either direction) → seasonal year + month. Values are never
 * invented: multi-hit substring refuses unless a profile month names one
 * season.
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

  // State name ↔ USPS code before substring (Maryland must not land on
  // Maryland Heights when MD is on the list).
  const statePick = pickUsStateOption(options, exp);
  if (statePick) return statePick;

  // Location strings before generic token overlap — Baltimore variants tie
  // under token scoring but resolve cleanly by comma-part comparison.
  const locPick = pickLocationOption(options, exp);
  if (locPick) return locPick;
  // Full state name with no USPS/name option: do not unique-substring
  // into "Maryland Heights". Codes like OR/IN still fall through.
  if (US_STATE_ABBR[optionKey(exp)]) {
    return {
      ok: false,
      reason: `no option matches "${exp}" (options: ${options.slice(0, 8).join(" | ")}${options.length > 8 ? " | …" : ""})`,
    };
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
    // Relocation sentence sets never lead with Yes/No (live: Cloudflare
    // "I am willing to relocate to this job's location." vs "I do not
    // live and not willing to relocate…"). Bank relocation=Yes means
    // willing; No means not willing. Only fires when the option set is
    // unambiguously relocation-shaped.
    const relocationOptions = options.filter((o) => /relocat/i.test(o));
    if (relocationOptions.length >= 2) {
      const willing = options.filter(
        (o) => /willing to relocate/i.test(o) && !/\bnot\b/i.test(optionKey(o)),
      );
      const notWilling = options.filter((o) =>
        /not willing to relocate|not able to relocate/i.test(o),
      );
      if (expYn === "yes" && willing.length === 1 && willing[0] !== undefined) {
        return { ok: true, label: willing[0], via: "synonym" };
      }
      if (expYn === "no" && notWilling.length === 1 && notWilling[0] !== undefined) {
        return { ok: true, label: notWilling[0], via: "synonym" };
      }
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
  const seasonal = pickSeasonalYearOption(options, exp);
  if (seasonal) return seasonal;
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
  const pSyns = usStateSynonyms(op);
  if (pSyns && pSyns.includes(od)) return true;
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
  const raw = await loc.evaluate((el: ContainerEl & { value?: string; parentElement?: ContainerEl | null }) => {
    // Paylocity FIRST. `[class*="select_"]` matches `pcty-input-select__input`
    // (the inner filter wrap), which does not contain the committed label.
    // Live 2026-08-19: display already said "United States"; verify read
    // the empty input and fill then typed a filter that wiped the pick.
    const pctyWrap =
      el.closest('[id$="-select-wrapper"]') ??
      el.closest('[class*="input-select-full-container"]') ??
      el.closest('[data-automation-id$="-input-base"]');
    if (pctyWrap) {
      const single = pctyWrap.querySelector('[class*="single-value"]');
      const t = (single?.textContent || "").replace(/\s+/g, " ").trim();
      if (t && !/^select(\s+a)?\s+(country|state|option|one)\b/i.test(t)) {
        return t;
      }
    }

    const shell =
      el.closest('[class*="select-shell"]') ??
      el.closest('[class*="select__control"]') ??
      el.closest('[class*="select_"]');
    if (!shell) {
      // Native role=combobox (employer sandbox / company-hosted): the
      // input value IS the committed display. Ignore it while the
      // listbox is open — that is filter residue, the Greenhouse lie.
      const host = el.closest("[class*='combo']") ?? el.parentElement;
      const list = host?.querySelector('[role="listbox"]');
      const doc = (
        globalThis as unknown as {
          getComputedStyle?: (n: unknown) => { display: string; visibility: string };
        }
      ).getComputedStyle;
      const open =
        list != null &&
        doc != null &&
        doc(list).display !== "none" &&
        doc(list).visibility !== "hidden";
      if (open) return null;
      const value = typeof el.value === "string" ? el.value.trim() : "";
      return value || null;
    }

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

const LISTBOX_SELECTOR =
  '[role="listbox"], [class*="select__menu"], [id$="-dropdown-list-container"]';
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

  // Location autocompletes ("Baltimore, Maryland, USA"): search by CITY
  // first — typing the whole comma string into an async place-search
  // returns nothing, and the last-resort word filters ("Maryland") pull
  // pure junk (live: Maryland Heights, Missouri…).
  const commaParts = full.split(",").map((p) => p.trim()).filter(Boolean);
  if (commaParts.length >= 2 && commaParts[0]!.length >= 3) {
    push(commaParts[0]!);
  }

  // Paylocity state lists filter on USPS codes. Typing "Maryland" yields
  // no rows; typing "MD" does. Only when the whole expected string is a
  // state — do not inject MD into "Baltimore, Maryland, USA".
  if (commaParts.length < 2) {
    const abbr = US_STATE_ABBR[optionKey(full)];
    if (abbr) push(abbr.toUpperCase());
  }

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
  const yearToken = cleaned.match(/\b(20\d{2}|19\d{2})\b/);
  if (yearToken?.[1]) push(yearToken[1]);
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
  // Paylocity: the inner filter input is not the open control. Click the
  // expand chevron (or the aria-haspopup wrapper) so the owned list mounts.
  const pcty = loc
    .locator('xpath=ancestor::*[@aria-haspopup="listbox"][1]')
    .first();
  let clickTarget: Locator;
  if ((await pcty.count()) > 0) {
    const icon = pcty
      .locator('[aria-label="expand"], [class*="dropdown-icon"]')
      .first();
    clickTarget = (await icon.count()) > 0 ? icon : pcty;
  } else {
    const control = loc
      .locator(
        'xpath=ancestor-or-self::*[contains(@class,"select__control") or contains(@class,"select-shell") or @role="combobox"][1]',
      )
      .first();
    clickTarget = (await control.count()) > 0 ? control : loc;
  }
  await clickTarget.scrollIntoViewIfNeeded().catch(() => undefined);

  notes.push(...(await clearComboboxSelection(page, clickTarget)));

  await clickTarget.click({ timeout: 10_000, force: true });
  notes.push("opened via control click");
  await page.waitForTimeout(200);
  return { clickTarget, notes };
}

async function listboxForControl(page: Page, loc: Locator): Promise<Locator> {
  const ownedId = await loc.evaluate(
    (el: {
      closest: (s: string) => { getAttribute: (n: string) => string | null } | null;
      getAttribute: (n: string) => string | null;
    }) => {
      const wrap = el.closest("[aria-owns]");
      return wrap?.getAttribute("aria-owns") ?? el.getAttribute("aria-controls");
    },
  );
  if (ownedId) {
    return page.locator(`[id="${ownedId.replace(/"/g, '\\"')}"]`);
  }
  return page.locator(LISTBOX_SELECTOR).filter({ visible: true }).first();
}

async function clickListedOption(
  listbox: Locator,
  expected: string,
): Promise<{ label: string; via: "exact" | "ci_exact" | "unique_substring" | "synonym" } | null> {
  const clean = (texts: string[]) =>
    texts.map((t) => t.replace(/\s+/g, " ").trim()).filter((t) => t.length > 0 && t.length < 80);

  const roleLabels = clean(
    await listbox.locator(OPTION_SELECTOR).filter({ visible: true }).allTextContents(),
  );
  const rolePick = pickOptionLabel(roleLabels, expected);
  if (rolePick.ok) {
    const byRole = listbox
      .getByRole("option", { name: rolePick.label, exact: true })
      .filter({ visible: true });
    if ((await byRole.count().catch(() => 0)) > 0) {
      await byRole.first().click({ timeout: 5_000, force: true });
      return { label: rolePick.label, via: rolePick.via };
    }
    const byClass = listbox
      .locator(OPTION_SELECTOR)
      .filter({ visible: true })
      .filter({ hasText: rolePick.label });
    if ((await byClass.count().catch(() => 0)) > 0) {
      await byClass.first().click({ timeout: 5_000, force: true });
      return { label: rolePick.label, via: rolePick.via };
    }
  }

  // Paylocity (live 2026-08-19): listbox opens, rows are plain divs with
  // no role=option, collector returned []. Click the visible string.
  const exact = listbox.getByText(expected, { exact: true }).filter({ visible: true });
  if ((await exact.count().catch(() => 0)) > 0) {
    await exact.first().click({ timeout: 5_000, force: true });
    return { label: expected, via: "exact" };
  }
  const loosePick = pickOptionLabel(
    clean(
      await listbox.locator("div, li, button").filter({ visible: true }).allTextContents(),
    ),
    expected,
  );
  if (loosePick.ok) {
    const named = listbox
      .getByText(loosePick.label, { exact: true })
      .filter({ visible: true });
    if ((await named.count().catch(() => 0)) > 0) {
      await named.first().click({ timeout: 5_000, force: true });
      return { label: loosePick.label, via: loosePick.via };
    }
  }
  return null;
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

  const already = await readComboboxValue(loc);
  if (already && labelsCompatible(expectedText, already)) {
    notes.push(`already committed "${already}"`);
    return {
      committed: true,
      selectedLabel: already,
      notes,
      pickVia: "exact",
    };
  }

  const opened = await openCombobox(page, loc);
  notes.push(...opened.notes);

  const listbox = await listboxForControl(page, loc);
  try {
    await listbox.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    notes.push("listbox did not open after click");
    return { committed: false, selectedLabel: null, notes };
  }

  const direct = await clickListedOption(listbox, expectedText);
  if (direct) {
    notes.push(`picked "${direct.label}" (${direct.via}) from open list`);
    await listbox
      .waitFor({ state: "hidden", timeout: 5_000 })
      .catch(async () => {
        notes.push("listbox still visible after pick");
        await page.keyboard.press("Escape").catch(() => undefined);
      });
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(250);
    let committedLabel = await readComboboxValue(loc);
    if (!committedLabel) {
      await page.waitForTimeout(300);
      committedLabel = await readComboboxValue(loc);
    }
    const committed = labelsCompatible(direct.label, committedLabel) ||
      Boolean(
        committedLabel &&
          normalize(committedLabel).includes(normalize(direct.label)),
      );
    if (!committed) {
      notes.push(
        `commit not confirmed: display shows ${committedLabel === null ? "placeholder" : `"${committedLabel}"`}`,
      );
    }
    return {
      committed,
      selectedLabel: committed ? (committedLabel ?? direct.label) : null,
      notes,
      pickVia: direct.via,
    };
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
        const typed = await clickListedOption(listbox, expectedText);
        if (typed) {
          notes.push(
            `filter "${typeText}" then picked "${typed.label}" (${typed.via})`,
          );
          await page.keyboard.press("Escape").catch(() => undefined);
          await page.waitForTimeout(250);
          const committedLabel = await readComboboxValue(loc);
          const committed =
            labelsCompatible(typed.label, committedLabel) ||
            Boolean(
              committedLabel &&
                normalize(committedLabel).includes(normalize(typed.label)),
            );
          return {
            committed,
            selectedLabel: committed ? (committedLabel ?? typed.label) : typed.label,
            notes,
            pickVia: typed.via,
          };
        }
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
      // Re-open and dump unfiltered (first virtualization window). Clear
      // typed residue FIRST — live (cc02e067) the leftover "Maryland"
      // filter made the "unfiltered" list pure junk (Maryland Heights,
      // Missouri…), poisoning both the pick and the artifact.
      await loc.click({ force: true, timeout: 2_000 }).catch(() => undefined);
      await page.keyboard.press("ControlOrMeta+a").catch(() => undefined);
      await page.keyboard.press("Delete").catch(() => undefined);
      await page.keyboard.press("Escape").catch(() => undefined);
      await openCombobox(page, loc);
      await listbox.waitFor({ state: "visible", timeout: 3_000 }).catch(() => undefined);
      await page.waitForTimeout(250);
      options = await collectOptions();
      notes.push("filter yielded no/unmatched options; re-collected unfiltered (residue cleared)");
      const afterOpen = await clickListedOption(listbox, expectedText);
      if (afterOpen) {
        notes.push(`picked "${afterOpen.label}" (${afterOpen.via}) after reopen`);
        await page.keyboard.press("Escape").catch(() => undefined);
        await page.waitForTimeout(250);
        const committedLabel = await readComboboxValue(loc);
        return {
          committed: Boolean(
            committedLabel &&
              (labelsCompatible(afterOpen.label, committedLabel) ||
                normalize(committedLabel).includes(normalize(afterOpen.label))),
          ),
          selectedLabel: committedLabel ?? afterOpen.label,
          notes,
          pickVia: afterOpen.via,
        };
      }
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
