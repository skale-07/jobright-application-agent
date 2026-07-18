import type { LaunchOptions } from "playwright";

export type BrowserChannel = "chrome" | "msedge" | "chromium";

/**
 * Google blocks OAuth in Playwright's bundled "Chrome for Testing".
 * Prefer the system Chrome/Edge channel for interactive login.
 * This is not stealth/evasion — it uses a real supported browser binary.
 */
export function parseBrowserChannel(raw: string | undefined): BrowserChannel {
  const v = (raw ?? "chrome").trim().toLowerCase();
  if (v === "chrome" || v === "msedge" || v === "chromium") return v;
  throw new Error(
    `Invalid BROWSER_CHANNEL "${raw}". Use chrome | msedge | chromium.`,
  );
}

export function resolveBrowserChannel(
  override?: BrowserChannel,
): BrowserChannel {
  if (override) return override;
  return parseBrowserChannel(process.env.BROWSER_CHANNEL);
}

export function browserLaunchOptions(overrides?: {
  headless?: boolean;
  slowMoMs?: number;
  channel?: BrowserChannel;
}): LaunchOptions {
  const channel = resolveBrowserChannel(overrides?.channel);
  const headless = overrides?.headless ?? false;
  const slowMo = overrides?.slowMoMs ?? 50;

  if (channel === "chromium") {
    return { headless, slowMo };
  }

  return {
    channel,
    headless,
    slowMo,
  };
}

export function browserChannelHint(channel: BrowserChannel): string {
  if (channel === "chromium") {
    return [
      "Using bundled Chromium (Chrome for Testing).",
      "Google Sign-In often fails with: \"This browser or app may not be secure.\"",
      "Fix: set BROWSER_CHANNEL=chrome (installed Google Chrome) and retry login.",
      "Or: npm run login:jobright -- --mode PERSISTENT_CONTEXT",
    ].join("\n");
  }
  return `Using system browser channel: ${channel}`;
}
