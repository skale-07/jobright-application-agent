import { buildConsentUrl, runGmailAuthFlow } from "../gmail/authFlow.js";
import type { FetchLike } from "../gmail/client.js";

/**
 * Drives the one-time Gmail OAuth flow from the console UI. The flow
 * itself is unchanged — it still blocks on askLineImpl waiting for the
 * pasted redirect URL — the broker just replaces that TTY prompt with a
 * promise the web endpoint resolves. Scope verification, the readonly
 * literal in the token schema, and the refusal to store a scope-less
 * grant all stay inside runGmailAuthFlow.
 *
 * One flow at a time. The client secret lives in memory for the duration
 * and is never echoed back in any response.
 */

export type BrokerStatus = "idle" | "awaiting_redirect_url" | "exchanging";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export class GmailAuthBroker {
  private status_: BrokerStatus = "idle";
  private resolvePaste: ((url: string) => void) | null = null;
  private rejectPaste: ((err: Error) => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private flow: Promise<string> | null = null;

  constructor(
    private readonly deps: {
      fetchImpl?: FetchLike;
      timeoutMs?: number;
    } = {},
  ) {}

  status(): BrokerStatus {
    return this.status_;
  }

  /** Begin a flow; returns the consent URL for the operator to open. */
  start(input: {
    email: string;
    clientId: string;
    clientSecret: string;
  }): { consentUrl: string } {
    if (this.status_ !== "idle") {
      throw new Error(
        `a Gmail auth flow is already ${this.status_} — finish or wait for it to time out`,
      );
    }
    this.status_ = "awaiting_redirect_url";
    const pasted = new Promise<string>((resolve, reject) => {
      this.resolvePaste = resolve;
      this.rejectPaste = reject;
    });
    this.timer = setTimeout(() => {
      this.rejectPaste?.(
        new Error("Gmail auth timed out waiting for the redirect URL — restart the flow"),
      );
    }, this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.timer.unref?.();

    this.flow = runGmailAuthFlow({
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      accountEmail: input.email,
      askLineImpl: () => pasted,
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
    }).finally(() => {
      this.reset();
    });
    // The flow promise is awaited by submitRedirectUrl; a rejection before
    // then must not surface as an unhandled rejection.
    this.flow.catch(() => undefined);

    return { consentUrl: buildConsentUrl(input.clientId) };
  }

  /** Hand the pasted redirect URL to the waiting flow; resolves to the token path. */
  async submitRedirectUrl(url: string): Promise<string> {
    if (this.status_ !== "awaiting_redirect_url" || !this.resolvePaste || !this.flow) {
      throw new Error("no Gmail auth flow is waiting for a redirect URL");
    }
    this.status_ = "exchanging";
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.resolvePaste(url);
    return this.flow;
  }

  private reset(): void {
    this.status_ = "idle";
    this.resolvePaste = null;
    this.rejectPaste = null;
    this.flow = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
