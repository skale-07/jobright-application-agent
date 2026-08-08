import type { ServerResponse } from "node:http";
import { getConfig } from "../config/index.js";
import { GmailClient } from "../gmail/client.js";
import { readGmailToken } from "../gmail/tokenStore.js";
import { readJsonBody } from "./body.js";
import type { Route } from "./routes.js";
import type { GmailAuthBroker } from "./gmailAuthBroker.js";

/**
 * Console endpoints for the one-time Gmail setup and its read-only smoke
 * test. Nothing here widens Gmail access: the flow stores a readonly
 * grant or refuses, and gmail:check runs through the same guarded client
 * (which throws unless GMAIL_VERIFICATION_ENABLED is set in the console
 * server's own shell).
 */

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body, null, 2));
}

export function buildGmailRoutes(deps: { broker: GmailAuthBroker }): Route[] {
  return [
    {
      method: "GET",
      pattern: "/api/gmail/status",
      handler: ({ res }) => {
        const token = readGmailToken();
        json(res, 200, {
          flow_status: deps.broker.status(),
          token_present: token !== null,
          account_email: token?.account_email ?? null,
          verification_enabled: getConfig().gmailVerificationEnabled,
        });
      },
    },
    {
      method: "POST",
      pattern: "/api/gmail/auth/start",
      handler: async ({ req, res }) => {
        const body = await readJsonBody(req);
        const email = typeof body["email"] === "string" ? body["email"] : "";
        const clientId =
          (typeof body["client_id"] === "string" ? body["client_id"] : "") ||
          process.env["GMAIL_OAUTH_CLIENT_ID"] ||
          "";
        const clientSecret =
          (typeof body["client_secret"] === "string" ? body["client_secret"] : "") ||
          process.env["GMAIL_OAUTH_CLIENT_SECRET"] ||
          "";
        if (!email || !clientId || !clientSecret) {
          json(res, 400, {
            error:
              "email plus client_id/client_secret are required (or set GMAIL_OAUTH_CLIENT_ID/SECRET in the console shell)",
          });
          return;
        }
        try {
          json(res, 200, deps.broker.start({ email, clientId, clientSecret }));
        } catch (err) {
          json(res, 409, { error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    {
      method: "POST",
      pattern: "/api/gmail/auth/redirect-url",
      handler: async ({ req, res }) => {
        const body = await readJsonBody(req);
        const url = typeof body["url"] === "string" ? body["url"] : "";
        if (!url) {
          json(res, 400, { error: "url (the pasted redirect URL) is required" });
          return;
        }
        try {
          const tokenPath = await deps.broker.submitRedirectUrl(url);
          json(res, 200, { token_path: tokenPath });
        } catch (err) {
          json(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    {
      method: "POST",
      pattern: "/api/gmail/check",
      handler: async ({ res }) => {
        try {
          const client = new GmailClient();
          const messages = await client.searchMessages("newer_than:1d", {
            maxResults: 5,
          });
          json(res, 200, {
            account_email: client.accountEmail,
            recent_message_count: messages.length,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          json(res, /GMAIL_VERIFICATION_ENABLED/.test(message) ? 403 : 400, {
            error: message,
          });
        }
      },
    },
  ];
}
