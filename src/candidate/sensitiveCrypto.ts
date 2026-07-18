import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getConfig } from "../config/index.js";

const KEY_BYTES = 32;

export function candidateKeyPaths(privateDir = getConfig().privateDir): {
  dpapiKeyPath: string;
  encProfilePath: string;
  plaintextDraftPath: string;
} {
  const dir = path.join(privateDir, "candidate");
  return {
    dpapiKeyPath: path.join(dir, "master.key.dpapi"),
    encProfilePath: path.join(dir, "sensitive-profile.enc"),
    plaintextDraftPath: path.join(dir, "sensitive-profile.draft.json"),
  };
}

/**
 * Resolve a 32-byte AES key.
 * Priority:
 * 1. Insecure env key when ALLOW_INSECURE_CANDIDATE_KEY=1 (tests/dev only)
 * 2. Windows DPAPI-wrapped master key file
 */
export function resolveCandidateDataKey(): Buffer {
  if (process.env.ALLOW_INSECURE_CANDIDATE_KEY === "1") {
    const raw = process.env.CANDIDATE_DATA_KEY;
    if (!raw) {
      throw new Error(
        "ALLOW_INSECURE_CANDIDATE_KEY=1 requires CANDIDATE_DATA_KEY (tests/dev only)",
      );
    }
    return normalizeKeyMaterial(raw);
  }

  if (process.platform === "win32") {
    return loadOrCreateDpapiKey();
  }

  throw new Error(
    "Candidate data key unavailable. On Windows, DPAPI master.key.dpapi is used. " +
      "For tests only, set ALLOW_INSECURE_CANDIDATE_KEY=1 and CANDIDATE_DATA_KEY.",
  );
}

function normalizeKeyMaterial(raw: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  return createHash("sha256").update(raw, "utf8").digest();
}

function loadOrCreateDpapiKey(): Buffer {
  const { dpapiKeyPath } = candidateKeyPaths();
  fs.mkdirSync(path.dirname(dpapiKeyPath), { recursive: true });
  if (fs.existsSync(dpapiKeyPath)) {
    return unprotectDpapiFile(dpapiKeyPath);
  }
  const key = randomBytes(KEY_BYTES);
  protectDpapiFile(dpapiKeyPath, key);
  return key;
}

function protectDpapiFile(filePath: string, plaintext: Buffer): void {
  const b64 = plaintext.toString("base64");
  const script = `
Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String('${b64}')
$protected = [System.Security.Cryptography.ProtectedData]::Protect(
  $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[IO.File]::WriteAllBytes('${filePath.replace(/'/g, "''")}', $protected)
`;
  execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function unprotectDpapiFile(filePath: string): Buffer {
  const script = `
Add-Type -AssemblyName System.Security
$protected = [IO.File]::ReadAllBytes('${filePath.replace(/'/g, "''")}')
$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
  $protected, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($bytes)
`;
  const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
  }).trim();
  const key = Buffer.from(out, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(`DPAPI key has unexpected length ${key.length}`);
  }
  return key;
}

export type EncryptedBlob = {
  v: 1;
  alg: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
};

export function encryptJson(data: unknown, key = resolveCandidateDataKey()): EncryptedBlob {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(data), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptJson<T>(blob: EncryptedBlob, key = resolveCandidateDataKey()): T {
  if (blob.v !== 1 || blob.alg !== "aes-256-gcm") {
    throw new Error("Unsupported encrypted blob format");
  }
  const iv = Buffer.from(blob.iv, "base64");
  const tag = Buffer.from(blob.tag, "base64");
  const ciphertext = Buffer.from(blob.ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

export function writeEncryptedFile(
  filePath: string,
  data: unknown,
  key = resolveCandidateDataKey(),
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const blob = encryptJson(data, key);
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(blob, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

export function readEncryptedFile<T>(
  filePath: string,
  key = resolveCandidateDataKey(),
): T {
  const blob = JSON.parse(fs.readFileSync(filePath, "utf8")) as EncryptedBlob;
  return decryptJson<T>(blob, key);
}
