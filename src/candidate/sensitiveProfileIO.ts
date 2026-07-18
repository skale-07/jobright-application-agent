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
