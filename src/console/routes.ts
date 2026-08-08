import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Tiny route table for the console: exact segments plus `:param` captures.
 * No wildcards, no regex — the API surface is small and fully enumerated.
 */

export type RouteHandler = (ctx: {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  searchParams: URLSearchParams;
}) => void | Promise<void>;

export type Route = {
  method: "GET" | "POST";
  pattern: string; // e.g. "/api/runs/:id/confirm"
  handler: RouteHandler;
};

export function matchPattern(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const patternParts = pattern.split("/").filter((p) => p.length > 0);
  const pathParts = pathname.split("/").filter((p) => p.length > 0);
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const pat = patternParts[i]!;
    const part = pathParts[i]!;
    if (pat.startsWith(":")) {
      params[pat.slice(1)] = decodeURIComponent(part);
    } else if (pat !== part) {
      return null;
    }
  }
  return params;
}

export function findRoute(
  routes: Route[],
  method: string,
  pathname: string,
): { route: Route; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const params = matchPattern(route.pattern, pathname);
    if (params) return { route, params };
  }
  return null;
}
