import fs from "node:fs";
import {
  candidateKeyPaths,
  readEncryptedFile,
  writeEncryptedFile,
} from "./sensitiveCrypto.js";
import { parseSensitiveProfile, type SensitiveProfile } from "./sensitiveProfile.js";

/**
 * Encrypt plaintext draft → sensitive-profile.enc, then delete the draft.
 * Never leaves plaintext sensitive JSON next to the enc file after success.
 */
export function encryptSensitiveProfileFromDraft(): {
  encPath: string;
  deletedDraft: boolean;
} {
  const paths = candidateKeyPaths();
  if (!fs.existsSync(paths.plaintextDraftPath)) {
    throw new Error(
      `Missing draft at ${paths.plaintextDraftPath}. Copy sensitive-profile.example.json to sensitive-profile.draft.json, fill values, then re-run.`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(paths.plaintextDraftPath, "utf8")) as unknown;
  const profile = parseSensitiveProfile(raw);
  writeEncryptedFile(paths.encProfilePath, profile);
  fs.unlinkSync(paths.plaintextDraftPath);
  return { encPath: paths.encProfilePath, deletedDraft: true };
}

export function loadSensitiveProfile(): SensitiveProfile {
  const paths = candidateKeyPaths();
  if (!fs.existsSync(paths.encProfilePath)) {
    throw new Error(
      `Missing ${paths.encProfilePath}. Run: npm run candidate:encrypt-sensitive`,
    );
  }
  const data = readEncryptedFile<unknown>(paths.encProfilePath);
  return parseSensitiveProfile(data);
}

/**
 * Soft load for fill: prefer encrypted profile, else draft (operator-supplied
 * plain values). Null when neither exists or parse fails — never invent values.
 */
export function tryLoadSensitiveProfile(): SensitiveProfile | null {
  const paths = candidateKeyPaths();
  try {
    if (fs.existsSync(paths.encProfilePath)) {
      return parseSensitiveProfile(
        readEncryptedFile<unknown>(paths.encProfilePath),
      );
    }
    if (fs.existsSync(paths.plaintextDraftPath)) {
      const raw = JSON.parse(
        fs.readFileSync(paths.plaintextDraftPath, "utf8"),
      ) as unknown;
      return parseSensitiveProfile(raw);
    }
  } catch {
    return null;
  }
  return null;
}

/** Resolve a demographic canonical from a loaded sensitive profile. */
export function getSensitiveValue(
  profile: SensitiveProfile,
  canonical: string,
): unknown {
  if (canonical === "gender_identity") return profile.gender_identity;
  if (canonical === "gender") return profile.gender;
  if (canonical === "race_ethnicity") {
    if (profile.race_ethnicity.length === 0) return "";
    // Multi-select boards: first stated race is enough for single-select UIs.
    return profile.race_ethnicity[0];
  }
  if (canonical === "sexual_orientation") return profile.sexual_orientation;
  if (canonical === "hispanic_latino") return profile.hispanic_latino;
  if (canonical === "transgender") return profile.transgender;
  if (canonical === "veteran_status") return profile.veteran_status;
  if (canonical === "disability_status") return profile.disability_status;
  return undefined;
}

export function sensitiveProfileStatus(): {
  encExists: boolean;
  draftExists: boolean;
  dpapiKeyExists: boolean;
} {
  const paths = candidateKeyPaths();
  return {
    encExists: fs.existsSync(paths.encProfilePath),
    draftExists: fs.existsSync(paths.plaintextDraftPath),
    dpapiKeyExists: fs.existsSync(paths.dpapiKeyPath),
  };
}
