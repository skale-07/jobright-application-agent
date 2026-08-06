import path from "node:path";
import { getConfig } from "../config/index.js";
import { validateJobrightAuthExtra } from "./jobrightValidateExtra.js";
import type { ServiceAuthConfig, ServiceName, SessionPersistenceMode } from "./types.js";

export function authPaths(privateDir = getConfig().privateDir): {
  authDir: string;
  profilesDir: string;
} {
  return {
    authDir: path.join(privateDir, "auth"),
    profilesDir: path.join(privateDir, "browser-profiles"),
  };
}

export function getServiceAuthConfig(service: ServiceName): ServiceAuthConfig {
  const { authDir, profilesDir } = authPaths();
  const modeEnv = process.env[`SESSION_MODE_${service.toUpperCase()}`];
  const defaultMode: SessionPersistenceMode =
    modeEnv === "PERSISTENT_CONTEXT" ? "PERSISTENT_CONTEXT" : "STORAGE_STATE";

  const shared = {
    storageStatePath: path.join(authDir, `${service}.storage.json`),
    persistentProfilePath: path.join(profilesDir, service),
    defaultMode,
    viewport: { width: 1280, height: 900 },
  };

  switch (service) {
    case "jobright":
      return {
        service,
        loginUrl: "https://jobright.ai/",
        validateUrl: "https://jobright.ai/jobs/recommend",
        unauthenticatedUrlPatterns: [
          /\/login/i,
          /\/signin/i,
          /\/sign-in/i,
          /accounts\.google\.com/i,
          /clerk\.|auth0\./i,
        ],
        checkpointUrlPatterns: [
          /\/challenge/i,
          /\/captcha/i,
          /\/verify/i,
          /signin\/rejected/i,
          /accounts\.google\.com\/v3\/signin\/rejected/i,
        ],
        validateExtra: validateJobrightAuthExtra,
        ...shared,
      };
    case "linkedin":
      return {
        service,
        loginUrl: "https://www.linkedin.com/login",
        validateUrl: "https://www.linkedin.com/feed/",
        unauthenticatedUrlPatterns: [/\/login/i, /\/uas\/login/i],
        checkpointUrlPatterns: [/\/checkpoint/i, /\/challenge/i],
        ...shared,
      };
    case "outlook":
      return {
        service,
        loginUrl: "https://outlook.live.com/mail/",
        validateUrl: "https://outlook.live.com/mail/",
        unauthenticatedUrlPatterns: [
          /login\.live\.com/i,
          /login\.microsoftonline\.com/i,
          /\/oauth2\//i,
          /\/login/i,
        ],
        checkpointUrlPatterns: [
          /\/proofs\//i,
          /\/interrupt\//i,
          /\/safelinks\//i,
          /account\.live\.com\/identity/i,
        ],
        ...shared,
      };
    default: {
      const _exhaustive: never = service;
      throw new Error(`Unknown service: ${_exhaustive}`);
    }
  }
}

export function parseServiceName(value: string): ServiceName {
  if (value === "jobright" || value === "linkedin" || value === "outlook") {
    return value;
  }
  throw new Error(`Invalid service "${value}". Use jobright | linkedin | outlook.`);
}

export function parseSessionMode(value: string | undefined): SessionPersistenceMode | undefined {
  if (value === undefined) return undefined;
  if (value === "STORAGE_STATE" || value === "PERSISTENT_CONTEXT") return value;
  throw new Error(`Invalid session mode "${value}". Use STORAGE_STATE | PERSISTENT_CONTEXT.`);
}
