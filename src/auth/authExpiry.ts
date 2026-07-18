import { createReviewItem } from "../queue/reviewItems.js";
import type { Db } from "../storage/db/client.js";
import type { AuthValidationResult, ServiceName } from "./types.js";

/**
 * Mid-run auth expiry handling: mark review item and optionally application.
 * Does not destroy completed application data.
 */
export function handleAuthExpiry(
  db: Db,
  input: {
    service: ServiceName;
    validation: AuthValidationResult;
    applicationId?: string;
  },
): { reviewItemId: string } {
  const item = createReviewItem(db, {
    ...(input.applicationId ? { applicationId: input.applicationId } : {}),
    kind: "AUTH_REQUIRED",
    title: `${input.service} authentication required`,
    payload: {
      service: input.service,
      status: input.validation.status,
      reason: input.validation.reason,
      url: input.validation.url,
      checked_at: input.validation.checkedAt,
    },
  });
  return { reviewItemId: item.id };
}
