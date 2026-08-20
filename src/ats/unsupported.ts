import type { ApplicationAdapter, DetectionResult, ApplicationInspection } from "./adapter.js";

export const UNSUPPORTED_ADAPTER_VERSION = 1;

// No host is a fill hard-stop. iCIMS/Oracle/Taleo used to live here and
// planApplicationFill threw "Fill supports greenhouse/… only". Those
// boards ask the same questions as everyone else; they go through the
// generic adapter. This class remains so inspect can still name a URL
// that no adapter can even fetch (non-https, JobRight).
const UNSUPPORTED_PATTERNS: Array<{ id: string; re: RegExp }> = [];

export class UnsupportedAtsAdapter implements ApplicationAdapter {
  readonly id = "unsupported";
  readonly version = UNSUPPORTED_ADAPTER_VERSION;

  async detect(input: { url: string; html: string }): Promise<DetectionResult> {
    for (const p of UNSUPPORTED_PATTERNS) {
      if (p.re.test(input.url) || p.re.test(input.html)) {
        return {
          matched: true,
          confidence: 0.95,
          atsId: p.id,
          evidence: [`unsupported ATS pattern: ${p.id}`],
        };
      }
    }
    return {
      matched: false,
      confidence: 0,
      atsId: this.id,
      evidence: [],
    };
  }

  async discoverFields(): Promise<never[]> {
    return [];
  }

  async inspect(input: {
    url: string;
    html: string;
    title?: string;
  }): Promise<ApplicationInspection> {
    const detection = await this.detect(input);
    return {
      ats: detection.atsId,
      adapter_version: this.version,
      url: input.url,
      title: input.title ?? "",
      requires_login: true,
      captcha_detected: false,
      account_creation_detected: /create (an )?account/i.test(input.html),
      fields: [],
      warnings: [
        `ATS "${detection.atsId}" is unsupported in V1 — skip and continue batch`,
      ],
    };
  }
}

export function isUnsupportedAtsId(atsId: string): boolean {
  return UNSUPPORTED_PATTERNS.some((p) => p.id === atsId) || atsId === "unsupported";
}
