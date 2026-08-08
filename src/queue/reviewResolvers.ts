import type { Db } from "../storage/db/client.js";
import type { ApplicationState } from "./states.js";
import { canTransition } from "./states.js";
import { getApplication, transitionApplication } from "./stateMachine.js";
import {
  listOpenReviewItems,
  resolveReviewItem,
  type ReviewItem,
} from "./reviewItems.js";
import {
  getLatestUncertainSubmission,
  markSubmissionFailed,
  markSubmissionVerified,
} from "./submissionsRepo.js";
import { setEmployerApplicationUrl } from "../applications/employerUrl.js";

/**
 * Operator review-item resolvers — the domain layer behind both the CLI
 * (review:resolve) and the console API. Every resolver requires an OPEN /
 * IN_PROGRESS item; a state transition happens only when the application
 * actually sits in the state the item kind blocks on — otherwise the item
 * is resolved item-only and the result says `transition_skipped` so the
 * operator sees exactly what happened. Transitions all go through the
 * state machine; there are no ad-hoc status writes here.
 */

export type ResolverResult = {
  review_item_id: string;
  action: string;
  application_id: string | null;
  application_state: ApplicationState | null;
  transition_skipped: string | null;
};

class ReviewResolverError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "ReviewResolverError";
  }
}
export { ReviewResolverError };

function requireOpenItem(db: Db, reviewItemId: string): ReviewItem {
  const item = listOpenReviewItems(db).find((i) => i.id === reviewItemId);
  if (!item) {
    throw new ReviewResolverError(
      `No open review item with id ${reviewItemId}`,
      404,
    );
  }
  return item;
}

function appState(db: Db, applicationId: string | null): ApplicationState | null {
  if (!applicationId) return null;
  return (getApplication(db, applicationId)?.state as ApplicationState) ?? null;
}

function result(
  db: Db,
  item: ReviewItem,
  action: string,
  transitionSkipped: string | null,
): ResolverResult {
  return {
    review_item_id: item.id,
    action,
    application_id: item.application_id,
    application_state: appState(db, item.application_id),
    transition_skipped: transitionSkipped,
  };
}

/**
 * UNCERTAIN_SUBMISSION — extracted verbatim from the CLI's review:resolve
 * (the CLI now delegates here). "submitted": the operator confirmed a
 * receipt exists; "not-submitted": confirmed nothing went through, with an
 * optional immediate requeue.
 */
export function resolveUncertainSubmission(
  db: Db,
  input: {
    reviewItemId: string;
    outcome: "submitted" | "not-submitted";
    requeue?: boolean;
    by?: string;
  },
): ResolverResult & { outcome: string } {
  const item = requireOpenItem(db, input.reviewItemId);
  if (item.kind !== "UNCERTAIN_SUBMISSION" || !item.application_id) {
    throw new ReviewResolverError(
      `resolveUncertainSubmission handles UNCERTAIN_SUBMISSION items only (got ${item.kind})`,
      400,
    );
  }
  const applicationId = item.application_id;
  const by = input.by ?? "review:resolve";
  const uncertain = getLatestUncertainSubmission(db, applicationId);

  if (input.outcome === "submitted") {
    if (uncertain) {
      markSubmissionVerified(db, uncertain.id, {
        submitted: true,
        submitted_at: new Date().toISOString(),
        confirmation_url: "operator://review-resolve",
        confirmation_text: "Operator confirmed receipt exists",
        application_identifier: null,
        screenshot_path: uncertain.screenshot_path ?? "",
      });
    }
    transitionApplication(db, {
      applicationId,
      nextState: "SUBMITTED",
      reason: `operator confirmed submission receipt (${by})`,
    });
    resolveReviewItem(db, item.id, { outcome: "submitted", by });
    return { ...result(db, item, "submitted", null), outcome: "submitted" };
  }

  if (uncertain) {
    markSubmissionFailed(db, uncertain.id, "operator confirmed nothing was submitted");
  }
  transitionApplication(db, {
    applicationId,
    nextState: "FAILED_RETRYABLE",
    reason: `operator confirmed no submission occurred (${by})`,
  });
  if (input.requeue === true) {
    transitionApplication(db, {
      applicationId,
      nextState: "QUEUED",
      reason: "operator requeue after uncertain resolution",
    });
  }
  resolveReviewItem(db, item.id, {
    outcome: "not-submitted",
    requeued: input.requeue === true,
    by,
  });
  return { ...result(db, item, "not-submitted", null), outcome: "not-submitted" };
}

/**
 * AUTH_REQUIRED / CAPTCHA_REQUIRED — the operator cleared the wall (logged
 * in / solved the captcha in a headed session), so re-open the employer
 * application. Transition only when the app still sits on the wall state.
 */
export function requeueAfterWall(
  db: Db,
  input: { reviewItemId: string; note?: string },
): ResolverResult {
  const item = requireOpenItem(db, input.reviewItemId);
  if (item.kind !== "AUTH_REQUIRED" && item.kind !== "CAPTCHA_REQUIRED") {
    throw new ReviewResolverError(
      `requeueAfterWall handles AUTH_REQUIRED/CAPTCHA_REQUIRED items only (got ${item.kind})`,
      400,
    );
  }
  const state = appState(db, item.application_id);
  let skipped: string | null = null;
  if (
    item.application_id &&
    state &&
    canTransition(state, "APPLICATION_OPENING") &&
    (state === "AUTH_REQUIRED" || state === "CAPTCHA_REQUIRED")
  ) {
    transitionApplication(db, {
      applicationId: item.application_id,
      nextState: "APPLICATION_OPENING",
      reason: `operator resolved ${item.kind.toLowerCase()} wall (console)`,
    });
  } else {
    skipped = `application state is ${state ?? "unknown"} — item resolved without transition`;
  }
  resolveReviewItem(db, item.id, {
    action: "requeue",
    by: "console",
    ...(input.note ? { operator_note: input.note } : {}),
  });
  return result(db, item, "requeue", skipped);
}

/**
 * UNSUPPORTED_ATS — the operator supplied a corrected employer URL on a
 * supported ATS (validated by setEmployerApplicationUrl, which refuses
 * anything unsupported), so re-open against it.
 */
export function requeueUnsupportedAts(
  db: Db,
  input: { reviewItemId: string; employerUrl?: string; note?: string },
): ResolverResult {
  const item = requireOpenItem(db, input.reviewItemId);
  if (item.kind !== "UNSUPPORTED_ATS") {
    throw new ReviewResolverError(
      `requeueUnsupportedAts handles UNSUPPORTED_ATS items only (got ${item.kind})`,
      400,
    );
  }
  if (!item.application_id) {
    throw new ReviewResolverError(
      "review item carries no application — nothing to requeue",
      400,
    );
  }
  if (input.employerUrl) {
    // Throws on unsupported/malformed URLs — the item stays open then.
    setEmployerApplicationUrl(db, item.application_id, input.employerUrl);
  }
  const state = appState(db, item.application_id);
  let skipped: string | null = null;
  if (state === "UNSUPPORTED_ATS") {
    transitionApplication(db, {
      applicationId: item.application_id,
      nextState: "APPLICATION_OPENING",
      reason: input.employerUrl
        ? "operator supplied a supported employer application URL (console)"
        : "operator requeued after unsupported-ATS review (console)",
    });
  } else {
    skipped = `application state is ${state ?? "unknown"} — item resolved without transition`;
  }
  resolveReviewItem(db, item.id, {
    action: "requeue",
    by: "console",
    ...(input.employerUrl ? { employer_url_updated: true } : {}),
    ...(input.note ? { operator_note: input.note } : {}),
  });
  return result(db, item, "requeue", skipped);
}

/** AMBIGUOUS_FIELD — operator resolved the ambiguity; re-verify the form. */
export function requeueAmbiguousField(
  db: Db,
  input: { reviewItemId: string; note?: string },
): ResolverResult {
  const item = requireOpenItem(db, input.reviewItemId);
  if (item.kind !== "AMBIGUOUS_FIELD") {
    throw new ReviewResolverError(
      `requeueAmbiguousField handles AMBIGUOUS_FIELD items only (got ${item.kind})`,
      400,
    );
  }
  const state = appState(db, item.application_id);
  let skipped: string | null = null;
  if (item.application_id && state === "AMBIGUOUS_FIELD") {
    transitionApplication(db, {
      applicationId: item.application_id,
      nextState: "FIELD_VERIFICATION",
      reason: "operator resolved ambiguous field (console)",
    });
  } else {
    skipped = `application state is ${state ?? "unknown"} — item resolved without transition`;
  }
  resolveReviewItem(db, item.id, {
    action: "requeue",
    by: "console",
    ...(input.note ? { operator_note: input.note } : {}),
  });
  return result(db, item, "requeue", skipped);
}

/**
 * Any kind — the operator is giving up on this application. Legal only
 * from states with a FAILED_FINAL edge; otherwise resolve item-only.
 */
export function abandonApplication(
  db: Db,
  input: { reviewItemId: string; note?: string },
): ResolverResult {
  const item = requireOpenItem(db, input.reviewItemId);
  const state = appState(db, item.application_id);
  let skipped: string | null = null;
  if (item.application_id && state && canTransition(state, "FAILED_FINAL")) {
    transitionApplication(db, {
      applicationId: item.application_id,
      nextState: "FAILED_FINAL",
      reason: "operator abandoned application (console)",
      route: "FAILED_FINAL",
    });
  } else {
    skipped = `no FAILED_FINAL edge from ${state ?? "unknown"} — item resolved without transition`;
  }
  resolveReviewItem(db, item.id, {
    action: "abandoned",
    by: "console",
    ...(input.note ? { operator_note: input.note } : {}),
  });
  return result(db, item, "abandon", skipped);
}

/**
 * Item-only dismissal — never touches application state. The default for
 * MANUAL/DUPLICATE_RISK (whose apps may sit in arbitrary states) and the
 * fallback everywhere else.
 */
export function dismissReviewItem(
  db: Db,
  input: { reviewItemId: string; note?: string },
): ResolverResult {
  const item = requireOpenItem(db, input.reviewItemId);
  resolveReviewItem(
    db,
    item.id,
    {
      action: "dismissed",
      by: "console",
      ...(input.note ? { operator_note: input.note } : {}),
    },
    "DISMISSED",
  );
  return result(db, item, "dismiss", null);
}
