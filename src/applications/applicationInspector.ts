import type { ApplicationInspection, DiscoveredField } from "../ats/adapter.js";
import { detectAts } from "../ats/registry.js";
import { isUnsupportedAtsId } from "../ats/unsupported.js";
import { loadAnswerAliases } from "../candidate/answerAliases.js";
import {
  essayFieldsOnly,
  isDemographicsField,
  type EssayClassification,
} from "./essayDetector.js";
import {
  mapDiscoveredFields,
  type MappedField,
} from "./fieldNormalization.js";
import { getConfig } from "../config/index.js";
import { isInspectionOnlyMode } from "./formFillGuards.js";

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
    route = "skip_unsupported_ats";
    notes.push("Route: skip unsupported ATS");
  } else if (inspection.requires_login) {
    route = "needs_login";
  } else if (inspection.captcha_detected) {
    route = "needs_human_captcha";
  } else if (inspection.account_creation_detected) {
    route = "needs_account_creation";
  } else if (essays.some((e) => e.is_essay)) {
    route = "needs_essay";
    notes.push(`${essays.filter((e) => e.is_essay).length} essay field(s) flagged`);
  } else if (unmappedRequired.length > 0) {
    route = "needs_review_unmapped";
    notes.push(
      `${unmappedRequired.length} required field(s) unmapped to answer aliases`,
    );
  } else if (inspection.ats === "greenhouse" || inspection.ats === "generic") {
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
