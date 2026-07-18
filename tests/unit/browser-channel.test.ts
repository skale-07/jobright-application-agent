import { describe, expect, it } from "vitest";
import {
  browserLaunchOptions,
  parseBrowserChannel,
} from "../../src/browser/launchOptions.js";
import { classifyAuthUrl } from "../../src/auth/authValidation.js";
import { getServiceAuthConfig } from "../../src/auth/serviceRegistry.js";

describe("browser channel", () => {
  it("defaults launch to system chrome channel", () => {
    expect(parseBrowserChannel(undefined)).toBe("chrome");
    expect(browserLaunchOptions({ channel: "chrome" }).channel).toBe("chrome");
    expect(browserLaunchOptions({ channel: "chromium" }).channel).toBeUndefined();
  });

  it("classifies google signin rejected as checkpoint", () => {
    const cfg = getServiceAuthConfig("jobright");
    const result = classifyAuthUrl(
      "https://accounts.google.com/v3/signin/rejected?app_domain=https://jobright.ai",
      cfg,
    );
    expect(result.status).toBe("CHECKPOINT");
    expect(result.ok).toBe(false);
  });
});
