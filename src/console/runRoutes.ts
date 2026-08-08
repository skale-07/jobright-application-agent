import type { ServerResponse } from "node:http";
import { readJsonBody } from "./body.js";
import type { Route } from "./routes.js";
import {
  GATED_FLAG_KEYS,
  readCeiling,
  type FlagOptIns,
  type GatedFlagKey,
} from "./flagCeiling.js";
import {
  AlreadyRunningError,
  RunManager,
  type RunKind,
  type SseFrame,
} from "./runManager.js";

/** Flags a kind cannot run without — pre-checked for a friendly 403; the
 * child's own guards (assertSubmitAllowed etc.) remain the enforcement. */
const KIND_MINIMUMS: Record<RunKind, { flags: GatedFlagKey[]; live_mode: boolean }> = {
  nav: { flags: ["NAVIGATION_ENABLED"], live_mode: false },
  submit: { flags: ["FORM_FILL_ENABLED", "SUBMIT_ENABLED"], live_mode: true },
  pipeline: { flags: [], live_mode: false }, // flag-off pipeline is a valid dry walk
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body, null, 2));
}

export function buildRunRoutes(deps: { runManager: RunManager }): Route[] {
  const { runManager } = deps;
  return [
    {
      method: "GET",
      pattern: "/api/flags",
      handler: ({ res }) => {
        const ceiling = readCeiling();
        json(res, 200, {
          ceiling: ceiling.flags,
          live_mode_available: ceiling.live_mode_available,
          always_forced: {
            SUBMIT_REQUIRES_LOCAL_CONFIRMATION: true,
            MAX_UNATTENDED_SUBMISSIONS_PER_RUN: 0,
          },
        });
      },
    },
    {
      method: "GET",
      pattern: "/api/runs",
      handler: ({ res }) => json(res, 200, runManager.list()),
    },
    {
      method: "GET",
      pattern: "/api/runs/:id",
      handler: ({ res, params, searchParams }) => {
        const run = runManager.get(params["id"]!);
        if (!run) {
          json(res, 404, { error: `no such run: ${params["id"]}` });
          return;
        }
        const afterSeq = Number(searchParams.get("after_seq") ?? "0") || 0;
        json(res, 200, {
          run,
          logs: runManager.logsAfter(run.id, afterSeq).slice(0, 1000),
        });
      },
    },
    {
      method: "GET",
      pattern: "/api/runs/:id/events",
      handler: ({ res, params }) => {
        const run = runManager.get(params["id"]!);
        if (!run) {
          json(res, 404, { error: `no such run: ${params["id"]}` });
          return;
        }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        const send = (frame: SseFrame): void => {
          res.write(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`);
        };
        // Replay: current status + recent logs + pending confirmation so a
        // late-joining tab is complete.
        send({ event: "status", data: { status: run.status, run } });
        const recent = runManager.logsAfter(run.id, 0);
        for (const line of recent.slice(-200)) {
          send({ event: "log", data: line });
        }
        if (run.pending_confirmation) {
          send({ event: "confirm", data: run.pending_confirmation });
        }
        if (run.report != null) {
          send({ event: "report", data: { report: run.report } });
        }
        const unsubscribe = runManager.subscribe(run.id, send);
        if (!unsubscribe) {
          // Run already finished — close after the replay.
          send({ event: "end", data: { status: run.status, exit_code: run.exit_code } });
          res.end();
          return;
        }
        const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
        res.on("close", () => {
          clearInterval(heartbeat);
          unsubscribe();
        });
      },
    },
    {
      method: "POST",
      pattern: "/api/runs",
      handler: async ({ req, res }) => {
        const body = await readJsonBody(req);
        const kind = body["kind"];
        if (kind !== "pipeline" && kind !== "nav" && kind !== "submit") {
          json(res, 400, { error: "kind must be pipeline | nav | submit" });
          return;
        }
        const params =
          body["params"] && typeof body["params"] === "object" && !Array.isArray(body["params"])
            ? (body["params"] as Record<string, unknown>)
            : {};
        const rawFlags =
          body["flags"] && typeof body["flags"] === "object" && !Array.isArray(body["flags"])
            ? (body["flags"] as Record<string, unknown>)
            : {};
        const optIns: FlagOptIns = {
          flags: Object.fromEntries(
            Object.entries(rawFlags)
              .filter(([k]) => (GATED_FLAG_KEYS as readonly string[]).includes(k))
              .map(([k, v]) => [k, v === true]),
          ) as NonNullable<FlagOptIns["flags"]>,
          live_mode: body["live_mode"] === true,
        };
        if ((kind === "nav" || kind === "submit") && typeof params["application_id"] !== "string") {
          json(res, 400, { error: `${kind} requires params.application_id` });
          return;
        }

        // Friendly pre-check: does the ceiling even allow this kind with
        // these opt-ins? (Real enforcement stays in the child's guards.)
        const ceiling = readCeiling();
        const minimum = KIND_MINIMUMS[kind];
        const missing: string[] = [];
        for (const flag of minimum.flags) {
          if (!(ceiling.flags[flag] && optIns.flags?.[flag] === true)) missing.push(flag);
        }
        if (minimum.live_mode && !(ceiling.live_mode_available && optIns.live_mode === true)) {
          missing.push("LIVE_MODE (shell DRY_RUN=false + opt-in)");
        }
        if (missing.length > 0) {
          json(res, 403, {
            error: `${kind} needs: ${missing.join(", ")} — enable in the console shell and opt in for this run`,
          });
          return;
        }

        try {
          const record = runManager.start({ kind, params, optIns });
          json(res, 201, {
            run_id: record.id,
            status: record.status,
            granted_flags: record.granted_flags,
            denied_flags: record.denied_flags,
          });
        } catch (err) {
          if (err instanceof AlreadyRunningError) {
            json(res, 409, { error: err.message });
            return;
          }
          throw err;
        }
      },
    },
    {
      method: "POST",
      pattern: "/api/runs/:id/confirm",
      handler: async ({ req, res, params }) => {
        const body = await readJsonBody(req);
        const confirmationId = body["confirmation_id"];
        if (typeof confirmationId !== "string" || typeof body["accept"] !== "boolean") {
          json(res, 400, { error: "confirmation_id (string) and accept (boolean) required" });
          return;
        }
        const outcome = runManager.confirm(params["id"]!, confirmationId, body["accept"]);
        if (outcome === "none") {
          json(res, 404, { error: "no pending confirmation for this run" });
          return;
        }
        if (outcome === "stale") {
          json(res, 409, { error: "confirmation_id is stale — refresh the run view" });
          return;
        }
        json(res, 200, { accepted: body["accept"] });
      },
    },
    {
      method: "POST",
      pattern: "/api/runs/:id/cancel",
      handler: ({ res, params }) => {
        if (!runManager.cancel(params["id"]!)) {
          json(res, 404, { error: "no active run with that id" });
          return;
        }
        json(res, 202, { canceling: params["id"] });
      },
    },
  ];
}
