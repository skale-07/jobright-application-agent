import {
  validateGreenhouseApplicationUrl,
  type GreenhouseUrlValidation,
} from "../greenhouse/urlValidation.js";
import {
  validateLeverApplicationUrl,
  type LeverUrlValidation,
} from "../lever/urlValidation.js";
import {
  validateAshbyApplicationUrl,
  type AshbyUrlValidation,
} from "../ashby/urlValidation.js";
import {
  validateWorkableApplicationUrl,
  type WorkableUrlValidation,
} from "../workable/urlValidation.js";
import {
  validateWorkdayApplicationUrl,
  type WorkdayUrlValidation,
} from "../workday/urlValidation.js";
import {
  validateGenericApplicationUrl,
  type GenericUrlValidation,
} from "../generic/urlValidation.js";
import { getConfig } from "../../config/index.js";

/**
 * Multi-ATS employer-URL gate. Each per-ATS validator carries its own
 * strict rejection battery (scheme/credentials/port/host/path); this
 * dispatcher just asks each in turn and reports which ATS claimed the URL.
 * Used by the pipeline URL gates, submit run, enqueue, and the CLI —
 * every seam that previously hardcoded validateGreenhouseApplicationUrl.
 */

export type SupportedAtsId =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "workable"
  | "workday"
  /**
   * Company-hosted forms — the long tail. Claimed only after every vendor
   * validator declines, so a supported ATS never lands here.
   */
  | "generic";

export type AtsUrlDetection =
  | {
      ats: "greenhouse";
      normalizedUrl: string;
      warnings: string[];
      validation: GreenhouseUrlValidation;
    }
  | {
      ats: "lever";
      normalizedUrl: string;
      warnings: string[];
      validation: LeverUrlValidation;
    }
  | {
      ats: "ashby";
      normalizedUrl: string;
      warnings: string[];
      validation: AshbyUrlValidation;
    }
  | {
      ats: "workable";
      normalizedUrl: string;
      warnings: string[];
      validation: WorkableUrlValidation;
    }
  | {
      ats: "workday";
      normalizedUrl: string;
      warnings: string[];
      validation: WorkdayUrlValidation;
    }
  | {
      ats: "generic";
      normalizedUrl: string;
      warnings: string[];
      validation: GenericUrlValidation;
    }
  | { ats: null; failureReason: string };

export function detectAtsFromUrl(rawUrl: string): AtsUrlDetection {
  const greenhouse = validateGreenhouseApplicationUrl(rawUrl);
  if (greenhouse.passed) {
    return {
      ats: "greenhouse",
      normalizedUrl: greenhouse.normalizedUrl ?? rawUrl,
      warnings: greenhouse.warnings,
      validation: greenhouse,
    };
  }
  const lever = validateLeverApplicationUrl(rawUrl);
  if (lever.passed) {
    return {
      ats: "lever",
      normalizedUrl: lever.normalizedUrl ?? rawUrl,
      warnings: lever.warnings,
      validation: lever,
    };
  }
  const ashby = validateAshbyApplicationUrl(rawUrl);
  if (ashby.passed) {
    return {
      ats: "ashby",
      normalizedUrl: ashby.normalizedUrl ?? rawUrl,
      warnings: ashby.warnings,
      validation: ashby,
    };
  }
  const workable = validateWorkableApplicationUrl(rawUrl);
  if (workable.passed) {
    return {
      ats: "workable",
      normalizedUrl: workable.normalizedUrl ?? rawUrl,
      warnings: workable.warnings,
      validation: workable,
    };
  }
  const workday = validateWorkdayApplicationUrl(rawUrl);
  if (workday.passed) {
    return {
      ats: "workday",
      normalizedUrl: workday.normalizedUrl ?? rawUrl,
      warnings: workday.warnings,
      validation: workday,
    };
  }
  // Last: any https employer form. Not a fallback that weakens the vendor
  // validators — they have all already declined — but the long tail (10 of
  // 41 resolved URLs in the live corpus, 10 distinct hosts). Trust comes
  // from provenance (JobRight posting -> navigation -> congruence), not
  // from a host allowlist; see generic/urlValidation.ts.
  //
  // No flag here (operator directive 2026-08-14, "why are you making the
  // system have so many useless gates"): the former GENERIC_ATS_ENABLED
  // gate parked every long-tail employer as UNSUPPORTED_ATS — a live armed
  // session resolved avature/gusto/saashr/techjobsforgood URLs and every
  // one dead-ended — and the console never granted the flag, so armed runs
  // could not use the adapter at all. Detection is read-only; mutation is
  // still behind FORM_FILL_ENABLED / DRY_RUN / SUBMIT_ENABLED like every
  // other adapter.
  const generic = validateGenericApplicationUrl(rawUrl);
  if (generic.passed) {
    return {
      ats: "generic",
      normalizedUrl: generic.normalizedUrl ?? rawUrl,
      warnings: generic.warnings,
      validation: generic,
    };
  }
  return {
    ats: null,
    failureReason: `no ATS matched — greenhouse: ${greenhouse.failureReason}; lever: ${lever.failureReason}; ashby: ${ashby.failureReason}; workable: ${workable.failureReason}; workday: ${workday.failureReason}; generic: ${generic.failureReason}`,
  };
}
