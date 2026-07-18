import type {
  ApplicationAdapter,
  ApplicationInspection,
  DetectionResult,
  DiscoveredField,
} from "./adapter.js";
import { discoverFieldsFromHtml } from "../applications/fieldDiscovery.js";

export const GENERIC_ADAPTER_VERSION = 1;

export class GenericAdapterV1 implements ApplicationAdapter {
  readonly id = "generic";
  readonly version = GENERIC_ADAPTER_VERSION;

  async detect(input: {
    url: string;
    html: string;
  }): Promise<DetectionResult> {
    const hasForm = /<form[\s>]/i.test(input.html);
    const hasInputs = /<input[\s>]|<textarea[\s>]|<select[\s>]/i.test(input.html);
    const matched = hasForm && hasInputs;
    return {
      matched,
      confidence: matched ? 0.4 : 0,
      atsId: this.id,
      evidence: matched ? ["generic form+inputs present"] : ["no form detected"],
    };
  }

  async discoverFields(input: { html: string }): Promise<DiscoveredField[]> {
    return discoverFieldsFromHtml(input.html);
  }

  async inspect(input: {
    url: string;
    html: string;
    title?: string;
  }): Promise<ApplicationInspection> {
    const fields = await this.discoverFields({ html: input.html });
    return {
      ats: this.id,
      adapter_version: this.version,
      url: input.url,
      title: input.title ?? "",
      requires_login: /sign in|log in|create an account/i.test(input.html),
      captcha_detected: /captcha|recaptcha|hcaptcha/i.test(input.html),
      account_creation_detected: /create (an )?account/i.test(input.html),
      fields,
      warnings: ["generic adapter — low confidence; review carefully"],
    };
  }
}
