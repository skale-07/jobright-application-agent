import OpenAI from "openai";
import { getConfig } from "../config/index.js";

/**
 * One of the sanctioned LLM boundaries in this codebase — all of which
 * reuse this client interface: outreach email generation (here), offline
 * selector-patch PROPOSALS (heal/submitInventoryHealer.ts), screener
 * label→key MAPPING (applications/screenerLlmMap.ts — never answers), and
 * essay DRAFT suggestions into review items (applications/essayDraft.ts —
 * never filled without human approval). Never demographics, never live
 * ATS interaction. Tests use stubs; no test ever calls out.
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
