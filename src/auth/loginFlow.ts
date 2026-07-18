import readline from "node:readline";
import { chromium } from "playwright";
import { closeDatabase, migrate, openDatabase } from "../storage/db/client.js";
import { logger } from "../logging/logger.js";
import { validateAuthFromPage } from "./authValidation.js";
import { getServiceAuthConfig } from "./serviceRegistry.js";
import { upsertServiceSessionStatus } from "./sessionStore.js";
import {
  assertLooksLikeStorageState,
  ensureParentDir,
  writeStorageStateFile,
} from "./storageStateManager.js";
import type { ServiceName, SessionPersistenceMode } from "./types.js";
import fs from "node:fs";

async function waitForEnter(prompt: string): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  await new Promise<void>((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

/**
 * Manual headed login. Never stores passwords — only Playwright storageState
 * or a dedicated persistent Chromium profile directory.
 */
export async function runLoginFlow(options: {
  service: ServiceName;
  mode?: SessionPersistenceMode;
}): Promise<void> {
  const cfg = getServiceAuthConfig(options.service);
  const mode = options.mode ?? cfg.defaultMode;

  console.log(`\nLogin: ${options.service}`);
  console.log(`Mode: ${mode}`);
  console.log(`1. Chromium will open to: ${cfg.loginUrl}`);
  console.log("2. Sign in manually in the browser.");
  console.log("3. Return here and press Enter when done.");
  console.log("Passwords are never saved by this tool.\n");

  if (mode === "PERSISTENT_CONTEXT") {
    fs.mkdirSync(cfg.persistentProfilePath, { recursive: true });
    const context = await chromium.launchPersistentContext(cfg.persistentProfilePath, {
      headless: false,
      slowMo: 50,
      viewport: cfg.viewport,
    });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(cfg.loginUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await waitForEnter("Press Enter after you have finished logging in... ");
      await page.goto(cfg.validateUrl, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      await page.waitForTimeout(1500);
      const validation = await validateAuthFromPage(page, cfg);
      if (!validation.ok) {
        throw new Error(
          `Login validation failed (${validation.status}): ${validation.reason}`,
        );
      }
      // Also export storageState from persistent context for dual readiness
      ensureParentDir(cfg.storageStatePath);
      const state = await context.storageState();
      writeStorageStateFile(cfg.storageStatePath, state);
      assertLooksLikeStorageState(cfg.storageStatePath);

      const db = openDatabase();
      try {
        migrate(db);
        upsertServiceSessionStatus(db, {
          service: options.service,
          mode,
          validation,
          metadata: { login: true },
        });
      } finally {
        closeDatabase(db);
      }

      logger.info("login saved", {
        service: options.service,
        action: "login_complete",
        metadata: { mode, status: validation.status },
      });
      console.log(`Authenticated. Persistent profile: ${cfg.persistentProfilePath}`);
      console.log(`Also wrote storageState: ${cfg.storageStatePath}`);
    } finally {
      await context.close();
    }
    return;
  }

  // STORAGE_STATE mode
  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const context = await browser.newContext({ viewport: cfg.viewport });
  try {
    const page = await context.newPage();
    await page.goto(cfg.loginUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitForEnter("Press Enter after you have finished logging in... ");
    await page.goto(cfg.validateUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await page.waitForTimeout(1500);
    const validation = await validateAuthFromPage(page, cfg);
    if (!validation.ok) {
      throw new Error(
        `Login validation failed (${validation.status}): ${validation.reason}`,
      );
    }
    const state = await context.storageState();
    writeStorageStateFile(cfg.storageStatePath, state);
    assertLooksLikeStorageState(cfg.storageStatePath);

    const db = openDatabase();
    try {
      migrate(db);
      upsertServiceSessionStatus(db, {
        service: options.service,
        mode,
        validation,
        metadata: { login: true },
      });
    } finally {
      closeDatabase(db);
    }

    logger.info("login saved", {
      service: options.service,
      action: "login_complete",
      metadata: { mode, status: validation.status },
    });
    console.log(`Authenticated. Saved storageState: ${cfg.storageStatePath}`);
  } finally {
    await context.close();
    await browser.close();
  }
}
