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

/**
 * Multi-ATS employer-URL gate. Each per-ATS validator carries its own
 * strict rejection battery (scheme/credentials/port/host/path); this
 * dispatcher just asks each in turn and reports which ATS claimed the URL.
 * Used by the pipeline URL gates, submit run, enqueue, and the CLI —
 * every seam that previously hardcoded validateGreenhouseApplicationUrl.
 */

export type SupportedAtsId = "greenhouse" | "lever" | "ashby";

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
  return {
    ats: null,
    failureReason: `no supported ATS matched — greenhouse: ${greenhouse.failureReason}; lever: ${lever.failureReason}; ashby: ${ashby.failureReason}`,
  };
}
