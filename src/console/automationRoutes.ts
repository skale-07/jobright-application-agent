import type { ServerResponse } from "node:http";
import type { Db } from "../storage/db/client.js";
import { logger } from "../logging/logger.js";
import {
  ArmConflictError,
  armSession,
  disarmSession,
  getArmStatus,
  hashArmToken,
} from "../automation/armSession.js";
import { readJsonBody } from "./body.js";
import type { Route } from "./routes.js";

/**
 * Arm/disarm/status for the L3 unattended session. Status is a tokenless
 * read (like the other GETs); arm and disarm are bearer-gated as every POST
 * already is. Arming records only a short hash of the boot token, never the
 * token itself.
 */

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body, null, 2));
}

function num(body: Record<string, unknown>, key: string): number | undefined {
  const v = body[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function buildAutomationRoutes(deps: { db: Db; token: string }): Route[] {
  return [
    {
      method: "GET",
      pattern: "/api/automation/status",
      handler: ({ res }) => json(res, 200, getArmStatus(deps.db)),
    },
    {
      method: "POST",
      pattern: "/api/automation/arm",
      handler: async ({ req, res }) => {
        const body = await readJsonBody(req);
        const durationMinutes = num(body, "duration_minutes");
        const maxSubmits = num(body, "max_submits");
        const maxApps = num(body, "max_apps");
        const discoverMax = num(body, "discover_max");
        const rediscoverEvery = num(body, "rediscover_every");
        try {
          const status = armSession(deps.db, {
            ...(durationMinutes !== undefined ? { durationMinutes } : {}),
            ...(maxSubmits !== undefined ? { maxSubmits } : {}),
            ...(maxApps !== undefined ? { maxApps } : {}),
            ...(discoverMax !== undefined ? { discoverMax } : {}),
            ...(rediscoverEvery !== undefined ? { rediscoverEvery } : {}),
            armedByTokenHash: hashArmToken(deps.token),
          });
          // Redacted: the token hash is deliberately not logged.
          logger.info("l3 session armed", {
            service: "automation",
            action: "arm",
            metadata: {
              armed_until: status.armed_until,
              max_submits: status.max_submits,
              max_apps: status.max_apps,
            },
          });
          json(res, 200, status);
        } catch (err) {
          if (err instanceof ArmConflictError) {
            json(res, err.statusCode, { error: err.message });
            return;
          }
          throw err;
        }
      },
    },
    {
      method: "POST",
      pattern: "/api/automation/disarm",
      handler: ({ res }) => {
        const status = disarmSession(deps.db);
        logger.info("l3 session disarmed", {
          service: "automation",
          action: "disarm",
        });
        json(res, 200, status);
      },
    },
  ];
}
