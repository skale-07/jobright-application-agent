import { getConfig } from "../config/index.js";
import { GMAIL_READONLY_SCOPE, GmailWriteForbiddenError } from "./readonlyGuards.js";
import { readGmailToken, type GmailTokenFile } from "./tokenStore.js";

/**
 * Zero-dependency readonly Gmail client (two REST endpoints via fetch —
 * the googleapis package would pull a large tree for this). The absence of
 * any send/modify method here is structural, and the granted scope is
 * asserted on the STORED grant at construction (plus on any refresh
 * response that reports scope): anything beyond gmail.readonly throws.
 */

export function assertGmailVerificationAllowed(reason: string): void {
  const cfg = getConfig();
  if (!cfg.gmailVerificationEnabled) {
    throw new Error(
      `GMAIL_VERIFICATION_ENABLED=false — refusing Gmail access (${reason}).`,
    );
  }
}

export type FetchLike = (
  url: string | URL,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export type GmailMessageSummary = { id: string };

export type GmailMessage = {
  id: string;
  subject: string;
  from: string;
  bodyText: string;
  internalDateMs: number;
};

export class GmailClient {
  private readonly token: GmailTokenFile;
  private readonly fetchImpl: FetchLike;
  private accessToken: string | null = null;

  constructor(options?: { token?: GmailTokenFile; fetchImpl?: FetchLike }) {
    assertGmailVerificationAllowed("GmailClient");
    const token = options?.token ?? readGmailToken();
    if (!token) {
      throw new Error(
        "Gmail token missing — run `npm run gmail:auth` once as the operator.",
      );
    }
    // The stored grant is the authority on scope — the refresh response's
    // scope field is optional, so trusting it alone would fail open.
    if (token.scope !== GMAIL_READONLY_SCOPE) {
      throw new GmailWriteForbiddenError(
        `Stored Gmail grant scope is not readonly (${token.scope}) — re-run gmail:auth.`,
      );
    }
    this.token = token;
    this.fetchImpl = options?.fetchImpl ?? (fetch as unknown as FetchLike);
  }

  get accountEmail(): string {
    return this.token.account_email;
  }

  async getAccessToken(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    const res = await this.fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.token.client_id,
        client_secret: this.token.client_secret,
        refresh_token: this.token.refresh_token,
        grant_type: "refresh_token",
      }).toString(),
    });
    if (!res.ok) {
      throw new Error(`Gmail token refresh failed (HTTP ${res.status})`);
    }
    const body = (await res.json()) as {
      access_token?: string;
      scope?: string;
    };
    if (!body.access_token) {
      throw new Error("Gmail token refresh returned no access_token");
    }
    // Secondary check: the stored grant was asserted readonly in the
    // constructor; if the refresh response reports scope at all, it must
    // agree (absence here no longer weakens anything).
    const scopes = (body.scope ?? "").split(/\s+/).filter(Boolean);
    const beyondReadonly = scopes.filter((s) => s !== GMAIL_READONLY_SCOPE);
    if (beyondReadonly.length > 0) {
      throw new GmailWriteForbiddenError(
        `Gmail token carries non-readonly scopes (${beyondReadonly.join(", ")}) — refusing. Re-run gmail:auth with readonly only.`,
      );
    }
    this.accessToken = body.access_token;
    return this.accessToken;
  }

  async searchMessages(
    query: string,
    options?: { maxResults?: number },
  ): Promise<GmailMessageSummary[]> {
    assertGmailVerificationAllowed("searchMessages");
    const token = await this.getAccessToken();
    const url = new URL(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages",
    );
    url.searchParams.set("q", query);
    url.searchParams.set(
      "maxResults",
      String(Math.min(options?.maxResults ?? 10, 10)),
    );
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Gmail search failed (HTTP ${res.status})`);
    const body = (await res.json()) as { messages?: Array<{ id: string }> };
    return (body.messages ?? []).map((m) => ({ id: m.id }));
  }

  async getMessage(id: string): Promise<GmailMessage> {
    assertGmailVerificationAllowed("getMessage");
    const token = await this.getAccessToken();
    const url = new URL(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}`,
    );
    url.searchParams.set("format", "full");
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Gmail getMessage failed (HTTP ${res.status})`);
    const body = (await res.json()) as {
      id: string;
      internalDate?: string;
      payload?: GmailPayload;
    };
    const headers = body.payload?.headers ?? [];
    const header = (name: string): string =>
      headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ??
      "";
    return {
      id: body.id,
      subject: header("Subject"),
      from: header("From"),
      bodyText: extractBodyText(body.payload),
      internalDateMs: Number(body.internalDate ?? 0),
    };
  }
}

type GmailPayload = {
  mimeType?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string };
  parts?: GmailPayload[];
};

function decodeB64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
    "utf8",
  );
}

/** Prefer text/plain parts; fall back to stripped text/html. */
export function extractBodyText(payload: GmailPayload | undefined): string {
  if (!payload) return "";
  const collect = (p: GmailPayload, want: string): string[] => {
    const out: string[] = [];
    if (p.mimeType?.startsWith(want) && p.body?.data) {
      out.push(decodeB64Url(p.body.data));
    }
    for (const part of p.parts ?? []) out.push(...collect(part, want));
    return out;
  };
  const plain = collect(payload, "text/plain").join("\n");
  if (plain.trim()) return plain;
  const html = collect(payload, "text/html").join("\n");
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    // Keep anchor targets — magic links usually live in hrefs, not text.
    .replace(/<a\b[^>]*href="([^"]+)"[^>]*>/gi, " $1 ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
