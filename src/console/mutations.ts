import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { Db } from "../storage/db/client.js";
import { getConfig } from "../config/index.js";
import { enqueueJobRightJobs } from "../jobright/enqueueJobs.js";
import { registerResumeMaterial } from "../jobright/materialsRegister.js";
import { retryFailedApplications } from "../pipeline/runPipeline.js";
import { recordEssayAnswer } from "../applications/essayAnswers.js";
import { listOpenReviewItems } from "../queue/reviewItems.js";
import {
  getSkipRequest,
  requestSkip,
  unskip,
} from "../automation/skipRequests.js";
import {
  ReviewResolverError,
  abandonApplication,
  dismissReviewItem,
  promoteScreenerPrediction,
  requeueAfterWall,
  requeueAmbiguousField,
  requeueUnsupportedAts,
  resolveUncertainSubmission,
} from "../queue/reviewResolvers.js";
import { readJsonBody, readRawBody, BodyError } from "./body.js";
import type { Route } from "./routes.js";

/**
 * Quick in-process mutation routes: none of these need capability flags —
 * they are operator bookkeeping (queue, review items, essays, materials),
 * the same operations the CLI exposes. Anything that opens a browser or
 * spends money goes through the RunManager instead (separate milestone).
 */

const UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024;

/** kind → actions the resolve endpoint accepts (mirrors the resolver layer). */
export const REVIEW_ACTION_MATRIX: Record<string, string[]> = {
  UNCERTAIN_SUBMISSION: ["submitted", "not-submitted", "dismiss"],
  AUTH_REQUIRED: ["requeue", "abandon", "dismiss"],
  CAPTCHA_REQUIRED: ["requeue", "abandon", "dismiss"],
  UNSUPPORTED_ATS: ["requeue", "abandon", "dismiss"],
  AMBIGUOUS_FIELD: ["requeue", "abandon", "dismiss"],
  ESSAY: ["dismiss"], // answers go through POST /api/essays/answer
  // promote-screener applies only to screener answer items (payload.source
  // "screener_question" or "screener_prediction"); the resolver rejects
  // everything else.
  MANUAL: ["dismiss", "promote-screener"],
  DUPLICATE_RISK: ["dismiss"],
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body, null, 2));
}

function str(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function buildMutationRoutes(deps: { db: Db }): Route[] {
  const { db } = deps;
  return [
    {
      method: "POST",
      pattern: "/api/enqueue",
      handler: async ({ req, res }) => {
        const body = await readJsonBody(req);
        const refs = Array.isArray(body["refs"])
          ? (body["refs"] as unknown[]).filter(
              (r): r is string => typeof r === "string" && r.trim().length > 0,
            )
          : [];
        if (refs.length === 0) {
          json(res, 400, { error: "refs must be a non-empty array of job refs/URLs" });
          return;
        }
        const employerUrl = str(body, "employer_url");
        if (employerUrl && refs.length > 1) {
          // Same rule as the CLI: one employer URL cannot apply to many jobs.
          json(res, 400, { error: "employer_url is only valid with a single ref" });
          return;
        }
        const report = enqueueJobRightJobs(db, refs, {
          ...(employerUrl ? { employerApplicationUrl: employerUrl } : {}),
        });
        json(res, 200, report);
      },
    },
    {
      method: "POST",
      pattern: "/api/retry",
      handler: ({ res }) => {
        json(res, 200, { retried: retryFailedApplications(db) });
      },
    },
    {
      method: "POST",
      pattern: "/api/review-items/:id/resolve",
      handler: async ({ req, res, params }) => {
        const body = await readJsonBody(req);
        const action = str(body, "action");
        const id = params["id"]!;
        const item = listOpenReviewItems(db).find((i) => i.id === id);
        if (!item) {
          json(res, 404, { error: `No open review item with id ${id}` });
          return;
        }
        const allowed = REVIEW_ACTION_MATRIX[item.kind] ?? ["dismiss"];
        if (!action || !allowed.includes(action)) {
          json(res, 400, {
            error: `action for ${item.kind} must be one of: ${allowed.join(", ")}`,
          });
          return;
        }
        const note = str(body, "note");
        try {
          switch (action) {
            case "submitted":
            case "not-submitted":
              json(
                res,
                200,
                resolveUncertainSubmission(db, {
                  reviewItemId: id,
                  outcome: action,
                  requeue: body["requeue"] === true,
                  by: "console",
                }),
              );
              return;
            case "requeue":
              if (item.kind === "UNSUPPORTED_ATS") {
                json(
                  res,
                  200,
                  requeueUnsupportedAts(db, {
                    reviewItemId: id,
                    ...(str(body, "employer_url")
                      ? { employerUrl: str(body, "employer_url")! }
                      : {}),
                    ...(note ? { note } : {}),
                  }),
                );
              } else if (item.kind === "AMBIGUOUS_FIELD") {
                json(
                  res,
                  200,
                  requeueAmbiguousField(db, {
                    reviewItemId: id,
                    ...(note ? { note } : {}),
                  }),
                );
              } else {
                json(
                  res,
                  200,
                  requeueAfterWall(db, {
                    reviewItemId: id,
                    ...(note ? { note } : {}),
                  }),
                );
              }
              return;
            case "abandon":
              json(
                res,
                200,
                abandonApplication(db, { reviewItemId: id, ...(note ? { note } : {}) }),
              );
              return;
            case "promote-screener":
              json(
                res,
                200,
                promoteScreenerPrediction(db, {
                  reviewItemId: id,
                  ...(str(body, "answer") !== undefined
                    ? { answer: str(body, "answer")! }
                    : {}),
                }),
              );
              return;
            case "dismiss":
              json(
                res,
                200,
                dismissReviewItem(db, { reviewItemId: id, ...(note ? { note } : {}) }),
              );
              return;
            default:
              json(res, 400, { error: `unknown action: ${action}` });
              return;
          }
        } catch (err) {
          if (err instanceof ReviewResolverError) {
            json(res, err.statusCode, { error: err.message });
            return;
          }
          throw err;
        }
      },
    },
    {
      method: "POST",
      pattern: "/api/applications/:id/automation",
      handler: async ({ req, res, params }) => {
        // Include/exclude an application from L3 automation. Stored in
        // versions_json.automation_excluded (no schema migration); the
        // worker's selection query skips excluded apps. Other keys in
        // versions_json are preserved.
        const body = await readJsonBody(req);
        if (typeof body["excluded"] !== "boolean") {
          json(res, 400, { error: "excluded must be a boolean" });
          return;
        }
        const id = params["id"]!;
        const row = db
          .prepare(`SELECT versions_json FROM applications WHERE id = ?`)
          .get(id) as { versions_json: string } | undefined;
        if (!row) {
          json(res, 404, { error: `No application with id ${id}` });
          return;
        }
        let versions: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(row.versions_json) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            versions = parsed as Record<string, unknown>;
          }
        } catch {
          versions = {};
        }
        versions["automation_excluded"] = body["excluded"];
        db.prepare(`UPDATE applications SET versions_json = ? WHERE id = ?`).run(
          JSON.stringify(versions),
          id,
        );
        json(res, 200, { application_id: id, automation_excluded: body["excluded"] });
      },
    },
    {
      method: "POST",
      pattern: "/api/applications/:id/skip",
      handler: async ({ req, res, params }) => {
        // Skip a job the agent is stuck on. Unlike the include/exclude
        // toggle above — which is only read when the worker PICKS an app —
        // this also interrupts a run already in flight: the pipeline reads
        // the marker between steps and stops working this application.
        // Skipping never changes the application's state, so the operator
        // can inspect it, fix what was wrong, and re-include it later.
        const body = await readJsonBody(req).catch(() => ({}) as Record<string, unknown>);
        const id = params["id"]!;
        const undo = body["undo"] === true;
        const reason =
          typeof body["reason"] === "string" ? body["reason"].slice(0, 200) : undefined;
        const ok = undo
          ? unskip(db, id)
          : requestSkip(db, id, reason);
        if (!ok) {
          json(res, 404, { error: `No application with id ${id}` });
          return;
        }
        json(res, 200, {
          application_id: id,
          skipped: !undo,
          skip_request: getSkipRequest(db, id),
        });
      },
    },
    {
      method: "POST",
      pattern: "/api/essays/answer",
      handler: async ({ req, res }) => {
        const body = await readJsonBody(req);
        const applicationId = str(body, "application_id");
        const fieldKey = str(body, "field_key");
        const text = typeof body["text"] === "string" ? body["text"] : "";
        if (!applicationId || !fieldKey || text.trim().length === 0) {
          json(res, 400, {
            error: "application_id, field_key and non-empty text are required",
          });
          return;
        }
        const outcome = recordEssayAnswer(db, {
          applicationId,
          fieldKey,
          text,
          sourceFile: "console",
          resolvedBy: "console",
        });
        json(res, 200, {
          answer_id: outcome.answerId,
          field_key: fieldKey,
          chars: text.trim().length,
          review_resolved: outcome.reviewResolved,
          unanswered_fields: outcome.unansweredFields,
          application_state: outcome.applicationState,
        });
      },
    },
    {
      method: "POST",
      pattern: "/api/materials/register",
      handler: async ({ req, res }) => {
        const body = await readJsonBody(req);
        const applicationId = str(body, "application_id");
        const filePath = str(body, "path");
        if (!applicationId || !filePath) {
          json(res, 400, { error: "application_id and path are required" });
          return;
        }
        const label = str(body, "label");
        const registered = registerResumeMaterial({
          db,
          applicationId,
          filePath,
          ...(label ? { label } : {}),
        });
        json(res, 200, registered);
      },
    },
    {
      method: "POST",
      pattern: "/api/materials/upload",
      handler: async ({ req, res }) => {
        const applicationId = req.headers["x-application-id"];
        const filename = req.headers["x-filename"];
        const label = req.headers["x-label"];
        if (typeof applicationId !== "string" || applicationId.length === 0) {
          json(res, 400, { error: "x-application-id header is required" });
          return;
        }
        const contentType = req.headers["content-type"] ?? "";
        if (!contentType.includes("application/pdf")) {
          json(res, 400, { error: "content-type must be application/pdf" });
          return;
        }
        let raw: Buffer;
        try {
          raw = await readRawBody(req, { limitBytes: UPLOAD_LIMIT_BYTES });
        } catch (err) {
          if (err instanceof BodyError) {
            json(res, err.statusCode, { error: err.message });
            return;
          }
          throw err;
        }
        if (raw.length === 0) {
          json(res, 400, { error: "empty upload" });
          return;
        }
        if (!raw.subarray(0, 5).toString("latin1").startsWith("%PDF-")) {
          json(res, 400, { error: "body does not look like a PDF (missing %PDF header)" });
          return;
        }
        const safeName = (typeof filename === "string" ? filename : "resume.pdf")
          .replace(/[^A-Za-z0-9._-]/g, "_")
          .replace(/\.+/g, ".")
          .slice(0, 80);
        const inbox = path.join(getConfig().privateDir, "materials-inbox");
        fs.mkdirSync(inbox, { recursive: true });
        const stored = path.join(inbox, `${randomUUID().slice(0, 8)}-${safeName}`);
        fs.writeFileSync(stored, raw, { mode: 0o600 });
        const registered = registerResumeMaterial({
          db,
          applicationId,
          filePath: stored,
          ...(typeof label === "string" && label.length > 0 ? { label } : {}),
        });
        json(res, 200, { ...registered, stored_path: stored });
      },
    },
    {
      method: "POST",
      pattern: "/api/materials/default-resume",
      handler: async ({ req, res }) => {
        // Store the uploaded PDF at DEFAULT_RESUME_PATH — the fallback the
        // pipeline auto-attaches when an application reaches materials with
        // none registered. Verified as a PDF the same way as per-app uploads.
        const contentType = req.headers["content-type"] ?? "";
        if (!contentType.includes("application/pdf")) {
          json(res, 400, { error: "content-type must be application/pdf" });
          return;
        }
        let raw: Buffer;
        try {
          raw = await readRawBody(req, { limitBytes: UPLOAD_LIMIT_BYTES });
        } catch (err) {
          if (err instanceof BodyError) {
            json(res, err.statusCode, { error: err.message });
            return;
          }
          throw err;
        }
        if (raw.length === 0 || !raw.subarray(0, 5).toString("latin1").startsWith("%PDF-")) {
          json(res, 400, { error: "body does not look like a PDF (missing %PDF header)" });
          return;
        }
        const target = getConfig().defaultResumePath;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, raw, { mode: 0o600 });
        json(res, 200, { default_resume_path: target, size_bytes: raw.length });
      },
    },
  ];
}
