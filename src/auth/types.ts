import type { Page } from "playwright";

export type ServiceName = "jobright" | "linkedin" | "outlook";

export type SessionPersistenceMode =
  | "STORAGE_STATE"
  | "PERSISTENT_CONTEXT"
  /** Attach to an operator-started debug Chrome over CDP (Phase 6 J1). */
  | "CDP_ATTACH";

export type AuthStatus =
  | "AUTHENTICATED"
  | "UNAUTHENTICATED"
  | "CHECKPOINT"
  | "UNKNOWN";

export type AuthValidationResult = {
  ok: boolean;
  status: AuthStatus;
  url: string;
  reason: string;
  checkedAt: string;
};

export type ServiceAuthConfig = {
  service: ServiceName;
  loginUrl: string;
  validateUrl: string;
  /** URL substrings that mean login / re-auth is required. */
  unauthenticatedUrlPatterns: RegExp[];
  /** URL substrings that mean challenge / checkpoint / 2FA wall. */
  checkpointUrlPatterns: RegExp[];
  storageStatePath: string;
  persistentProfilePath: string;
  defaultMode: SessionPersistenceMode;
  viewport: { width: number; height: number };
  validateExtra?: (page: Page) => Promise<AuthValidationResult | null>;
};

export type ServiceSessionOptions = {
  service: ServiceName;
  mode?: SessionPersistenceMode;
  headless?: boolean;
  slowMoMs?: number;
  /** Recorder / download workflows */
  acceptDownloads?: boolean;
  /** Skip auth validate on open (tests only) */
  skipAuthValidation?: boolean;
};
