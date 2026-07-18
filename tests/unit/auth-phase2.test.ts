import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { classifyAuthUrl } from "../../src/auth/authValidation.js";
import { getServiceAuthConfig, parseServiceName, parseSessionMode } from "../../src/auth/serviceRegistry.js";
import { assertLooksLikeStorageState, writeStorageStateFile } from "../../src/auth/storageStateManager.js";
import { handleAuthExpiry } from "../../src/auth/authExpiry.js";
import { upsertServiceSessionStatus, getServiceSessionRow } from "../../src/auth/sessionStore.js";
import {
  closeDatabase,
  migrate,
  openDatabase,
  type Db,
} from "../../src/storage/db/client.js";
import { resetConfigCache } from "../../src/config/index.js";
import {
  decryptJson,
  encryptJson,
  writeEncryptedFile,
  readEncryptedFile,
} from "../../src/candidate/sensitiveCrypto.js";
import { parseSensitiveProfile } from "../../src/candidate/sensitiveProfile.js";
import { listOpenReviewItems } from "../../src/queue/reviewItems.js";

describe("auth validation", () => {
  it("classifies linkedin login and checkpoint urls", () => {
    const cfg = getServiceAuthConfig("linkedin");
    expect(classifyAuthUrl("https://www.linkedin.com/login", cfg).status).toBe(
      "UNAUTHENTICATED",
    );
    expect(
      classifyAuthUrl("https://www.linkedin.com/checkpoint/challenge/", cfg).status,
    ).toBe("CHECKPOINT");
    expect(classifyAuthUrl("https://www.linkedin.com/feed/", cfg).ok).toBe(true);
  });

  it("classifies outlook microsoft login redirects", () => {
    const cfg = getServiceAuthConfig("outlook");
    expect(
      classifyAuthUrl("https://login.microsoftonline.com/common/oauth2/v2.0/authorize", cfg)
        .status,
    ).toBe("UNAUTHENTICATED");
  });

  it("parses service and mode", () => {
    expect(parseServiceName("jobright")).toBe("jobright");
    expect(() => parseServiceName("x")).toThrow();
    expect(parseSessionMode("PERSISTENT_CONTEXT")).toBe("PERSISTENT_CONTEXT");
    expect(parseSessionMode(undefined)).toBeUndefined();
  });
});

describe("storage state manager", () => {
  it("writes and validates storage state shape", () => {
    const file = path.join(os.tmpdir(), `jaa-ss-${randomUUID()}.storage.json`);
    writeStorageStateFile(file, { cookies: [], origins: [] });
    expect(() => assertLooksLikeStorageState(file)).not.toThrow();
    fs.unlinkSync(file);
  });
});

describe("auth expiry and session store", () => {
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    resetConfigCache();
    dbPath = path.join(os.tmpdir(), `jaa-auth-${randomUUID()}.sqlite`);
    process.env.DATABASE_PATH = dbPath;
    db = openDatabase(dbPath);
    migrate(db);
  });

  afterEach(() => {
    closeDatabase(db);
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it("creates AUTH_REQUIRED review item on expiry", () => {
    const { reviewItemId } = handleAuthExpiry(db, {
      service: "linkedin",
      validation: {
        ok: false,
        status: "UNAUTHENTICATED",
        url: "https://www.linkedin.com/login",
        reason: "test",
        checkedAt: new Date().toISOString(),
      },
    });
    expect(listOpenReviewItems(db).some((r) => r.id === reviewItemId)).toBe(true);
  });

  it("upserts service session status", () => {
    upsertServiceSessionStatus(db, {
      service: "jobright",
      mode: "STORAGE_STATE",
      validation: {
        ok: true,
        status: "AUTHENTICATED",
        url: "https://jobright.ai/",
        reason: "ok",
        checkedAt: new Date().toISOString(),
      },
    });
    const row = getServiceSessionRow(db, "jobright");
    expect(row?.last_status).toBe("AUTHENTICATED");
  });
});

describe("sensitive crypto", () => {
  beforeEach(() => {
    process.env.ALLOW_INSECURE_CANDIDATE_KEY = "1";
    process.env.CANDIDATE_DATA_KEY = "test-key-material-phase2-unit";
  });

  afterEach(() => {
    delete process.env.ALLOW_INSECURE_CANDIDATE_KEY;
    delete process.env.CANDIDATE_DATA_KEY;
  });

  it("round-trips encrypted json", () => {
    const profile = parseSensitiveProfile({
      gender_identity: "",
      race_ethnicity: [],
      sexual_orientation: "",
      veteran_status: "",
      disability_status: "",
      self_identification_preferences: {},
    });
    const blob = encryptJson(profile);
    const back = decryptJson<typeof profile>(blob);
    expect(back).toEqual(profile);
  });

  it("writes and reads enc file", () => {
    const file = path.join(os.tmpdir(), `jaa-enc-${randomUUID()}.enc`);
    writeEncryptedFile(file, { hello: "world" });
    expect(readEncryptedFile<{ hello: string }>(file).hello).toBe("world");
    fs.unlinkSync(file);
  });
});
