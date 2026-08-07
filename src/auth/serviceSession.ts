import fs from "node:fs";
import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import { browserLaunchOptions } from "../browser/launchOptions.js";
import { getConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { validateAuthFromPage } from "./authValidation.js";
import { getServiceAuthConfig } from "./serviceRegistry.js";
import { requireStorageState, storageStateExists } from "./storageStateManager.js";
import type {
  AuthValidationResult,
  ServiceName,
  ServiceSessionOptions,
  SessionPersistenceMode,
} from "./types.js";

export interface ServiceSession {
  readonly service: ServiceName;
  readonly mode: SessionPersistenceMode;
  open(): Promise<void>;
  newPage(options?: { purpose?: string }): Promise<Page>;
  validate(): Promise<AuthValidationResult>;
  close(): Promise<void>;
}

/**
 * Per-service browser session. No module-level browser globals.
 * STORAGE_STATE is default; PERSISTENT_CONTEXT is a per-service fallback.
 */
export class PlaywrightServiceSession implements ServiceSession {
  readonly service: ServiceName;
  readonly mode: SessionPersistenceMode;
  private readonly headless: boolean;
  private readonly slowMoMs: number;
  private readonly acceptDownloads: boolean;
  private readonly skipAuthValidation: boolean;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private opened = false;

  constructor(options: ServiceSessionOptions) {
    const cfg = getServiceAuthConfig(options.service);
    this.service = options.service;
    this.mode = options.mode ?? cfg.defaultMode;
    this.headless = options.headless ?? false;
    this.slowMoMs = options.slowMoMs ?? 50;
    this.acceptDownloads = options.acceptDownloads ?? false;
    this.skipAuthValidation = options.skipAuthValidation ?? false;
  }

  async open(): Promise<void> {
    if (this.opened) {
      throw new Error(`ServiceSession already open for ${this.service}`);
    }
    const cfg = getServiceAuthConfig(this.service);
    const launch = browserLaunchOptions({
      headless: this.headless,
      slowMoMs: this.slowMoMs,
    });

    if (this.mode === "CDP_ATTACH") {
      // Attach to the operator's debug Chrome (scripts/start-chrome-debug-*).
      // We do not own this browser: close() disconnects and must never kill
      // it or close its real contexts/pages.
      const cdpUrl = getConfig().agentCdpUrl;
      this.browser = await chromium.connectOverCDP(cdpUrl);
      this.context =
        this.browser.contexts()[0] ?? (await this.browser.newContext());
    } else if (this.mode === "PERSISTENT_CONTEXT") {
      fs.mkdirSync(cfg.persistentProfilePath, { recursive: true });
      this.context = await chromium.launchPersistentContext(cfg.persistentProfilePath, {
        ...launch,
        viewport: cfg.viewport,
        acceptDownloads: this.acceptDownloads,
      });
      this.browser = null;
    } else {
      requireStorageState(cfg.storageStatePath);
      this.browser = await chromium.launch(launch);
      this.context = await this.browser.newContext({
        storageState: cfg.storageStatePath,
        viewport: cfg.viewport,
        acceptDownloads: this.acceptDownloads,
      });
    }

    this.opened = true;
    if (!this.skipAuthValidation) {
      const validation = await this.validate();
      if (!validation.ok) {
        await this.close();
        throw new Error(
          `${this.service} session invalid (${validation.status}): ${validation.reason}. Re-run npm run login:${this.service}.`,
        );
      }
      logger.info("service session opened", {
        service: this.service,
        action: "session_open",
        metadata: { mode: this.mode, status: validation.status },
      });
    }
  }

  /** Advanced: context listeners (recorder). Prefer newPage() for normal work. */
  getContext(): BrowserContext {
    this.assertOpen();
    return this.context!;
  }

  async newPage(options?: { purpose?: string }): Promise<Page> {
    this.assertOpen();
    const page = await this.context!.newPage();
    if (options?.purpose) {
      logger.debug("page created", {
        service: this.service,
        action: "new_page",
        metadata: { purpose: options.purpose },
      });
    }
    return page;
  }

  async validate(): Promise<AuthValidationResult> {
    this.assertOpen();
    const cfg = getServiceAuthConfig(this.service);
    const page = await this.context!.newPage();
    try {
      await page.goto(cfg.validateUrl, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      await page.waitForTimeout(1000);
      return await validateAuthFromPage(page, cfg);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    const ctx = this.context;
    const browser = this.browser;
    this.context = null;
    this.browser = null;
    this.opened = false;
    if (this.mode === "CDP_ATTACH") {
      // Disconnect only. The context belongs to the operator's Chrome —
      // closing it would close their real tabs. browser.close() on a
      // connected browser disconnects without terminating the process.
      if (browser) await browser.close().catch(() => undefined);
      return;
    }
    if (ctx) await ctx.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
  }

  private assertOpen(): void {
    if (!this.opened || !this.context) {
      throw new Error(`ServiceSession not open for ${this.service}`);
    }
  }
}

export function describeSessionReadiness(
  service: ServiceName,
  mode: SessionPersistenceMode,
): {
  ready: boolean;
  detail: string;
} {
  const cfg = getServiceAuthConfig(service);
  if (mode === "STORAGE_STATE") {
    if (!storageStateExists(cfg.storageStatePath)) {
      return {
        ready: false,
        detail: `Missing ${cfg.storageStatePath}`,
      };
    }
    return { ready: true, detail: `storageState present at ${cfg.storageStatePath}` };
  }
  if (!fs.existsSync(cfg.persistentProfilePath)) {
    return {
      ready: false,
      detail: `Missing persistent profile ${cfg.persistentProfilePath}`,
    };
  }
  return { ready: true, detail: `persistent profile at ${cfg.persistentProfilePath}` };
}
