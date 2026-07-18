import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { closeDatabase, migrate, openDatabase } from "../storage/db/client.js";
import { logger } from "../logging/logger.js";
import { waitForEnter } from "../util/stdin.js";
import {
  browserChannelHint,
  browserLaunchOptions,
} from "../browser/launchOptions.js";
import { getConfig } from "../config/index.js";
import { validateAuthFromPage } from "./authValidation.js";
import { getServiceAuthConfig } from "./serviceRegistry.js";
import { upsertServiceSessionStatus } from "./sessionStore.js";
import {
  assertLooksLikeStorageState,
  ensureParentDir,
  writeStorageStateFile,
} from "./storageStateManager.js";
import type { ServiceName, SessionPersistenceMode } from "./types.js";

const DEFAULT_CDP = "http://127.0.0.1:9222";

/**
 * Manual headed login. Never stores passwords.
 *
 * For JobRight Google OAuth: Playwright-launched Chrome is still blocked by
 * Google (automation signals). Prefer --cdp attach to a Chrome YOU started.
 */
export async function runLoginFlow(options: {
  service: ServiceName;
  mode?: SessionPersistenceMode;
  /** Connect to an already-running Chrome with remote debugging. */
  cdpUrl?: string;
}): Promise<void> {
  if (options.cdpUrl) {
    await runCdpLoginFlow({
      service: options.service,
      cdpUrl: options.cdpUrl,
    });
    return;
  }

  const cfg = getServiceAuthConfig(options.service);
  const mode = options.mode ?? cfg.defaultMode;
  const channel = getConfig().browserChannel;
  const launch = browserLaunchOptions({ headless: false, slowMoMs: 50 });

  console.log(`\nLogin: ${options.service}`);
  console.log(`Mode: ${mode}`);
  console.log(browserChannelHint(channel));
  if (options.service === "jobright") {
    console.log(jobrightGoogleWarning());
  }
  console.log(`1. Browser will open to: ${cfg.loginUrl}`);
  console.log("2. Sign in manually.");
  console.log("3. Return here and press Enter when done.");
  console.log("Passwords are never saved by this tool.\n");

  if (mode === "PERSISTENT_CONTEXT") {
    fs.mkdirSync(cfg.persistentProfilePath, { recursive: true });
    const context = await chromium.launchPersistentContext(cfg.persistentProfilePath, {
      ...launch,
      viewport: cfg.viewport,
    });
    try {
      await finishLoginInContext({
        service: options.service,
        mode,
        context,
        channel,
        closeBrowser: null,
      });
    } finally {
      await context.close();
    }
    return;
  }

  const browser = await chromium.launch(launch);
  const context = await browser.newContext({ viewport: cfg.viewport });
  try {
    await finishLoginInContext({
      service: options.service,
      mode,
      context,
      channel,
      closeBrowser: browser,
    });
  } finally {
    await context.close();
    await browser.close();
  }
}

/**
 * Attach to Chrome started by the operator (no Playwright launch during Google OAuth).
 */
export async function runCdpLoginFlow(options: {
  service: ServiceName;
  cdpUrl: string;
}): Promise<void> {
  const cfg = getServiceAuthConfig(options.service);
  const cdpUrl = options.cdpUrl.trim() || DEFAULT_CDP;

  console.log(`\nLogin via CDP: ${options.service}`);
  console.log(`CDP: ${cdpUrl}`);
  console.log(
    "Playwright will attach to your already-running Chrome and only SAVE the session.",
  );
  console.log("Complete Google Sign-In in that Chrome window first if needed.\n");

  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(cdpUrl);
  } catch (err) {
    throw new Error(
      [
        `Could not connect to Chrome at ${cdpUrl}.`,
        "Start Chrome with remote debugging first:",
        `  npm run chrome:debug:${options.service}`,
        "Then sign into JobRight with Google in that window.",
        "Then re-run:",
        `  npm run login:${options.service} -- --cdp ${cdpUrl}`,
        err instanceof Error ? `Detail: ${err.message}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    let page = context.pages()[0];
    if (!page) {
      page = await context.newPage();
      await page.goto(cfg.loginUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    }

    console.log(`Attached. Current URL: ${page.url()}`);
    await waitForEnter(
      "Press Enter after you are logged into JobRight in that Chrome window... ",
    );

    await page.goto(cfg.validateUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await page.waitForTimeout(1500);
    const validation = await validateAuthFromPage(page, cfg);
    if (!validation.ok) {
      throw new Error(
        `Login validation failed (${validation.status}): ${validation.reason}\n` +
          googleOauthHint(validation.url),
      );
    }

    ensureParentDir(cfg.storageStatePath);
    const state = await context.storageState();
    writeStorageStateFile(cfg.storageStatePath, state);
    assertLooksLikeStorageState(cfg.storageStatePath);

    const db = openDatabase();
    try {
      migrate(db);
      upsertServiceSessionStatus(db, {
        service: options.service,
        mode: "STORAGE_STATE",
        validation,
        metadata: { login: true, method: "cdp", cdpUrl },
      });
    } finally {
      closeDatabase(db);
    }

    logger.info("login saved via CDP", {
      service: options.service,
      action: "login_complete_cdp",
      metadata: { status: validation.status },
    });
    console.log(`Authenticated. Saved storageState: ${cfg.storageStatePath}`);
    console.log("You can close the debug Chrome window now.");
  } finally {
    // Disconnect only — do not kill the user's Chrome.
    await browser.close();
  }
}

async function finishLoginInContext(options: {
  service: ServiceName;
  mode: SessionPersistenceMode;
  context: BrowserContext;
  channel: string;
  closeBrowser: Browser | null;
}): Promise<void> {
  const cfg = getServiceAuthConfig(options.service);
  const page: Page =
    options.context.pages()[0] ?? (await options.context.newPage());
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
      `Login validation failed (${validation.status}): ${validation.reason}\n` +
        googleOauthHint(validation.url),
    );
  }
  ensureParentDir(cfg.storageStatePath);
  const state = await options.context.storageState();
  writeStorageStateFile(cfg.storageStatePath, state);
  assertLooksLikeStorageState(cfg.storageStatePath);

  const db = openDatabase();
  try {
    migrate(db);
    upsertServiceSessionStatus(db, {
      service: options.service,
      mode: options.mode,
      validation,
      metadata: { login: true, browserChannel: options.channel },
    });
  } finally {
    closeDatabase(db);
  }

  logger.info("login saved", {
    service: options.service,
    action: "login_complete",
    metadata: {
      mode: options.mode,
      status: validation.status,
      browserChannel: options.channel,
    },
  });
  if (options.mode === "PERSISTENT_CONTEXT") {
    console.log(`Authenticated. Persistent profile: ${cfg.persistentProfilePath}`);
  }
  console.log(`Saved storageState: ${cfg.storageStatePath}`);
  void options.closeBrowser;
}

export function cdpUserDataDir(service: ServiceName): string {
  const cfg = getServiceAuthConfig(service);
  return path.join(path.dirname(cfg.persistentProfilePath), `${service}-cdp`);
}

export function defaultCdpUrl(): string {
  return process.env.CDP_URL?.trim() || DEFAULT_CDP;
}

function jobrightGoogleWarning(): string {
  return [
    "",
    "WARNING: JobRight Google Sign-In usually FAILS in Playwright-launched Chrome",
    '(even real Chrome) with "This browser or app may not be secure".',
    "Recommended:",
    "  1. npm run chrome:debug:jobright",
    "  2. Sign in with Google in that window",
    "  3. npm run login:jobright -- --cdp http://127.0.0.1:9222",
    "",
  ].join("\n");
}

function googleOauthHint(url: string): string {
  if (!/accounts\.google\.com|signin\/rejected/i.test(url)) {
    return "";
  }
  return [
    "",
    "Google rejected this browser because it is automation-controlled.",
    "Installing Chrome is not enough — Playwright-launched Chrome is still blocked.",
    "Use CDP attach instead:",
    "  npm run chrome:debug:jobright",
    "  (sign in with Google in that window)",
    "  npm run login:jobright -- --cdp http://127.0.0.1:9222",
    "Do not use stealth plugins. Do not copy your everyday Chrome profile.",
  ].join("\n");
}

/** Resolve Chrome executable on Windows for debug launcher scripts. */
export function findChromeExecutable(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA
      ? path.join(
          process.env.LOCALAPPDATA,
          "Google",
          "Chrome",
          "Application",
          "chrome.exe",
        )
      : undefined,
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
