import { upsertOpenReviewItem } from "../queue/reviewItems.js";
import { transitionApplication, getApplication } from "../queue/stateMachine.js";
import type { Db } from "../storage/db/client.js";
import type { AuthValidationResult, ServiceName } from "./types.js";

/**
 * Mid-run auth expiry: one open AUTH_REQUIRED review (deduped), optional app transition.
 * Does not destroy completed application data.
 */
export function handleAuthExpiry(
  db: Db,
  input: {
    service: ServiceName;
    validation?: AuthValidationResult;
    detail?: string;
    applicationId?: string;
  },
): { reviewItemId: string; created: boolean } {
  const title = `${input.service} authentication required`;
  const { item, created } = upsertOpenReviewItem(db, {
    ...(input.applicationId ? { applicationId: input.applicationId } : {}),
    kind: "AUTH_REQUIRED",
    title,
    payload: {
      service: input.service,
      detail: input.detail ?? null,
      status: input.validation?.status ?? "UNAUTHENTICATED",
      reason: input.validation?.reason ?? input.detail ?? "auth expiry",
      url: input.validation?.url ?? null,
      checked_at: input.validation?.checkedAt ?? new Date().toISOString(),
    },
  });

  if (input.applicationId) {
    const app = getApplication(db, input.applicationId);
    if (
      app &&
      (app.state === "APPLICATION_OPENING" ||
        app.state === "APPLICATION_INSPECTION" ||
        app.state === "MATERIALS_GENERATING" ||
        app.state === "QUEUED")
    ) {
      try {
        if (app.state === "QUEUED" || app.state === "MATERIALS_GENERATING") {
          // Route via APPLICATION_OPENING first when needed
          if (app.state === "QUEUED") {
            transitionApplication(db, {
              applicationId: input.applicationId,
              nextState: "MATERIALS_GENERATING",
              reason: "auth_expiry_preamble",
            });
          }
          // From MATERIALS_GENERATING we can't go to AUTH_REQUIRED directly —
          // only mark review; leave state for resume after login.
        } else {
          transitionApplication(db, {
            applicationId: input.applicationId,
            nextState: "AUTH_REQUIRED",
            reason: "auth_expiry",
            route: "AUTH_REQUIRED",
          });
        }
      } catch {
        // Graph may not allow transition; review item is enough
      }
    }
  }

  return { reviewItemId: item.id, created };
}
