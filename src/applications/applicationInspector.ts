import type { ApplicationInspection, DiscoveredField } from "../ats/adapter.js";
import { detectAts } from "../ats/registry.js";
import { isUnsupportedAtsId } from "../ats/unsupported.js";
import { loadAnswerAliases } from "../candidate/answerAliases.js";
import {
  classifyEssayFields,
  essayFieldsOnly,
  isDemographicsField,
  isEssayRequiredGateEnabled,
  type EssayClassification,
} from "./essayDetector.js";
import {
  mapDiscoveredFields,
  type MappedField,
} from "./fieldNormalization.js";
import { getConfig } from "../config/index.js";
import { isInspectionOnlyMode } from "./formFillGuards.js";
import { detectAtsFromUrl } from "../ats/shared/urlValidationDispatch.js";
import { classifyPage } from "../ats/shared/pageClassify.js";

export type ApplicationRouteDecision =
  | "inspect_only"
  | "ready_for_fill_later"
  | "skip_unsupported_ats"
  | "needs_login"
  | "needs_human_captcha"
  | "needs_account_creation"
  | "needs_essay"
  | "needs_review_unmapped";

export type ApplicationInspectReport = {
  inspection: ApplicationInspection;
  detection_confidence: number;
  detection_evidence: string[];
  mapped_fields: MappedField[];
  essays: EssayClassification[];
  demographics_fields: DiscoveredField[];
  unmapped_required: MappedField[];
  route: ApplicationRouteDecision;
  form_fill_enabled: boolean;
  inspection_only: boolean;
  notes: string[];
};

/**
 * Stage 1 application inspection — detect ATS, discover/map fields, route.
 * Never fills or submits.
 */
export async function inspectApplicationHtml(input: {
  url: string;
  html: string;
  title?: string;
}): Promise<ApplicationInspectReport> {
  const { adapter, detection } = await detectAts(input);
  const inspection = await adapter.inspect(input);
  const aliases = loadAnswerAliases();
  const mapped = mapDiscoveredFields(inspection.fields, aliases);
  const essays = essayFieldsOnly(inspection.fields);
  const demographics = inspection.fields.filter(isDemographicsField);
  const unmappedRequired = mapped.filter(
    (f) => f.required && !f.canonical_field && f.type !== "file",
  );

  const notes: string[] = [...inspection.warnings];
  let route: ApplicationRouteDecision = "inspect_only";

  if (isUnsupportedAtsId(inspection.ats) || inspection.ats === "unknown") {
    // The HTML names no vendor — but that is a fact about the PAGE, not
    // the application. Live run 2a9f9930 (2026-08-15): Paycom, Oracle
    // Cloud and ByteDance apps all had navigation succeed (Apply click →
    // popup captured → generic URL validated) and then died RIGHT HERE,
    // because a posting page / account modal carries no vendor markers.
    // Three navigations done perfectly, three "unsupported ATS" parks.
    //
    // When the URL itself already passed an adapter's validation (which is
    // how the pipeline reached inspection at all), a vendor-blind page is
    // routed by what the page IS: an auth wall goes to the portal-auth
    // path, a captcha still parks, and everything else proceeds to fill —
    // whose own pre-mutation gate, posting advance and zero-field refusal
    // decide with the page actually rendered in a real browser. A refusal
    // from there names the true blocker; "unsupported ATS" named nothing.
    const urlClaim = detectAtsFromUrl(input.url);
    if (urlClaim.ats !== null) {
      const landing = classifyPage({
        url: input.url,
        html: input.html,
        ...(input.title !== undefined ? { title: input.title } : {}),
      });
      notes.push(
        `vendor-unknown page on a ${urlClaim.ats}-validated URL — classified ${landing.page_class}, proceeding (fill's gate decides)`,
      );
      if (landing.page_class === "captcha") {
        route = "needs_human_captcha";
      } else if (landing.page_class === "auth" || inspection.requires_login) {
        route = "needs_login";
      } else if (inspection.account_creation_detected) {
        route = "needs_account_creation";
      } else {
        route = "ready_for_fill_later";
      }
      return {
        inspection,
        detection_confidence: detection.confidence,
        detection_evidence: detection.evidence,
        mapped_fields: mapped,
        essays,
        demographics_fields: demographics,
        unmapped_required: unmappedRequired,
        route,
        form_fill_enabled: getConfig().formFillEnabled,
        inspection_only: isInspectionOnlyMode(),
        notes,
      };
    }
    route = "skip_unsupported_ats";
    notes.push("Route: skip unsupported ATS (URL claimed by no adapter)");
  } else if (inspection.requires_login) {
    route = "needs_login";
  } else if (inspection.captcha_detected) {
    route = "needs_human_captcha";
  } else if (inspection.account_creation_detected) {
    route = "needs_account_creation";
  } else if (
    isEssayRequiredGateEnabled() &&
    essays.some((e) => e.is_essay)
  ) {
    route = "needs_essay";
    notes.push(`${essays.filter((e) => e.is_essay).length} essay field(s) flagged`);
  } else if (unmappedRequired.length > 0) {
    route = "needs_review_unmapped";
    notes.push(
      `${unmappedRequired.length} required field(s) unmapped to answer aliases`,
    );
  } else if (
    ["greenhouse", "lever", "ashby", "generic"].includes(inspection.ats)
  ) {
    route = "ready_for_fill_later";
    notes.push(
      "Mapped enough for a future fill phase — FORM_FILL stays off in Phase 4",
    );
  }

  const cfg = getConfig();
  return {
    inspection,
    detection_confidence: detection.confidence,
    detection_evidence: detection.evidence,
    mapped_fields: mapped,
    essays,
    demographics_fields: demographics,
    unmapped_required: unmappedRequired,
    route,
    form_fill_enabled: cfg.formFillEnabled,
    inspection_only: isInspectionOnlyMode(),
    notes,
  };
}
