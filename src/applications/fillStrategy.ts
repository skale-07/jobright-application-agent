import { getConfig } from "../config/index.js";
import {
  probeCdpTargetsForExtension,
  type PreflightSeams,
} from "../automation/extensionPreflight.js";
import { jobrightExtensionSelectorsV1 } from "../jobright/extension/selectors.js";

/**
 * Which fill strategy serves an application (X2). EXTENSION_FIRST — let
 * JobRight's extension fill, verify, gap-fill natively — requires EVERY
 * one of: the JOBRIGHT_AUTOFILL_ENABLED opt-in, a run that can use the
 * CDP Chrome (the extension lives there; fixture runs and the held
 * launched-browser submit session cannot), a "present" extension
 * preflight, and promoted trigger selectors. Anything less is
 * NATIVE_ONLY — today's deterministic path, unchanged.
 */
export type FillStrategy = "EXTENSION_FIRST" | "NATIVE_ONLY";

export type FillStrategyResolution = {
  strategy: FillStrategy;
  notes: string[];
};

export async function resolveFillStrategy(input: {
  fixture: boolean;
  submitHeld: boolean;
  seams?: PreflightSeams;
  triggerSelectors?: string[];
}): Promise<FillStrategyResolution> {
  const cfg = getConfig();
  const native = (note: string): FillStrategyResolution => ({
    strategy: "NATIVE_ONLY",
    notes: [note],
  });
  if (!cfg.jobrightAutofillEnabled) {
    return native("JOBRIGHT_AUTOFILL_ENABLED is off — native fill");
  }
  if (input.fixture) {
    return native("fixture run — extension unavailable, native fill");
  }
  if (input.submitHeld) {
    return native(
      "submit-held session is a launched browser without the extension — native fill",
    );
  }
  const triggers =
    input.triggerSelectors ?? jobrightExtensionSelectorsV1.autofillTrigger;
  if (triggers.length === 0) {
    return native(
      "no promoted autofill-trigger selectors — run jobright:ext-capture first; native fill",
    );
  }
  const preflight = await probeCdpTargetsForExtension(
    cfg.agentCdpUrl,
    input.seams ?? {},
  );
  if (preflight.verdict !== "present") {
    return native(
      `extension preflight ${preflight.verdict} (${preflight.notes[0] ?? "no detail"}) — native fill`,
    );
  }
  return {
    strategy: "EXTENSION_FIRST",
    notes: [
      `extension present (${preflight.matched_targets[0] ?? "matched"}) — extension-first fill`,
    ],
  };
}
