import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * Request-level security for the operator console. The console is a
 * localhost-only tool, but "localhost-only" alone does not stop a hostile
 * web page in the operator's browser: DNS rebinding defeats the bind
 * address (Host check) and cross-site requests can reach mutation routes
 * (per-boot bearer token, unguessable and never persisted).
 */

/** Per-boot token; delivered to the operator via the printed #token= URL fragment. */
export function generateBootToken(): string {
  return randomBytes(32).toString("hex");
}

/** Host header must name localhost (optionally with a port) — DNS-rebinding guard. */
export function checkHostHeader(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host) return false;
  const name = host.replace(/:\d+$/, "").toLowerCase();
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]";
}

/** Constant-time bearer check for mutation routes. */
export function checkBearerToken(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const presented = header.slice("Bearer ".length).trim();
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
