import OpenAI from "openai";
import { getConfig } from "../config/index.js";

/**
 * The only LLM boundary in this codebase. Outreach email generation only —
 * never form answers, essays, demographics, or any ATS interaction.
 * Tests use a stub implementing this interface; no test ever calls out.
 */
export interface EmailLlmClient {
  /** Returns the raw model output string (expected to be JSON). */
  generateJson(input: { system: string; user: string }): Promise<{
    text: string;
    model: string;
  }>;
}

export class OpenAiEmailClient implements EmailLlmClient {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor() {
    const cfg = getConfig();
    if (!cfg.openaiApiKey) {
      throw new Error(
        "OPENAI_API_KEY is not set — outreach generation needs it in .env",
      );
    }
    this.client = new OpenAI({ apiKey: cfg.openaiApiKey });
    this.model = cfg.emailLlmModel;
  }

  async generateJson(input: {
    system: string;
    user: string;
  }): Promise<{ text: string; model: string }> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
    });
    const text = response.choices[0]?.message?.content ?? "";
    return { text, model: response.model ?? this.model };
  }
}
