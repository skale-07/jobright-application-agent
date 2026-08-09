/**
 * Prediction tier for screener answers — the "leeway" layer. When the
 * operator's bank has NO answer for a matched key, a per-key deterministic
 * predictor may derive one from the public profile (degree → education
 * level, address → closest location). Predictions get no special trust:
 *   - bank answers always win (the human's word beats the derivation);
 *   - a predicted choice must still match a literal page option through
 *     the same conservative resolver, or the field parks;
 *   - the plan entry is labeled profile_derived, so the fill-outcomes
 *     corpus records exactly which fills were predictions — and the ones
 *     that PASS live verification surface via `screeners:suggest` as
 *     ready-to-paste bank labels. Prediction that works becomes a label;
 *     prediction that doesn't becomes a review item. Either way it
 *     becomes data.
 * Only keys listed here are predictable; commitments (availability,
 * relocation) are never predicted — those are the human's promises.
 */
import type { PublicProfile } from "./publicProfile.js";

export type ScreenerPrediction = {
  value: string;
  /** Where the derivation came from — rides into the entry reason. */
  derivation: string;
};

type Predictor = (profile: PublicProfile) => ScreenerPrediction | null;

function predictEducationLevel(profile: PublicProfile): ScreenerPrediction | null {
  const degree = (profile.degree ?? "").toLowerCase();
  if (!degree) return null;
  if (/bachelor|\bbs\b|\bba\b|\bbse\b|undergrad/.test(degree)) {
    return { value: "Undergrad", derivation: `degree "${profile.degree}"` };
  }
  if (/master|\bms\b|\bmeng\b|mba/.test(degree)) {
    return { value: "Master's/MBA", derivation: `degree "${profile.degree}"` };
  }
  if (/phd|doctor/.test(degree)) {
    return { value: "PhD", derivation: `degree "${profile.degree}"` };
  }
  return null;
}

function predictClosestLocation(profile: PublicProfile): ScreenerPrediction | null {
  const country = (profile.address?.country ?? "").trim();
  if (!country) return null;
  return { value: country, derivation: `address country "${country}"` };
}

const PREDICTORS: Record<string, Predictor> = {
  education_level: predictEducationLevel,
  closest_location: predictClosestLocation,
};

/** Extra option-matching aliases for predicted values (country spellings). */
export const PREDICTION_OPTION_ALIASES: Record<string, string[]> = {
  "United States": ["united states", "usa", "us", "u.s.", "united states of america", "north america"],
  Canada: ["canada", "north america"],
  "United Kingdom": ["united kingdom", "uk", "u.k.", "great britain", "england", "europe"],
};

export function predictScreenerAnswer(
  key: string,
  profile: PublicProfile,
): ScreenerPrediction | null {
  const predictor = PREDICTORS[key];
  if (!predictor) return null;
  try {
    return predictor(profile);
  } catch {
    return null;
  }
}

export function isPredictableKey(key: string): boolean {
  return key in PREDICTORS;
}
