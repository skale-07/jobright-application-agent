import type { ApplicationAdapter, DetectionResult, ApplicationInspection } from "./adapter.js";

export const UNSUPPORTED_ADAPTER_VERSION = 1;

const UNSUPPORTED_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: "workday", re: /myworkdayjobs\.com|workday\.com/i },
  { id: "icims", re: /icims\.com/i },
  { id: "oracle", re: /oraclecloud\.com|taleo/i },
];

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
