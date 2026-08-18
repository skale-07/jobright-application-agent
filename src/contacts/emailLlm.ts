import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { getConfig, type AppConfig } from "../config/index.js";

/**
 * One of the sanctioned LLM boundaries in this codebase — all of which
 * reuse this client interface: outreach email generation (here), offline
 * selector-patch PROPOSALS (heal/submitInventoryHealer.ts), screener
 * label→key MAPPING (applications/screenerLlmMap.ts — never answers), and
 * essay DRAFT suggestions into review items (applications/essayDraft.ts —
 * never filled without human approval). Never demographics, never live
 * ATS interaction. Tests use stubs; no test ever calls out.
 *
 * Three providers, one preference order: Anthropic when ANTHROPIC_API_KEY
 * is set (the operator's better-funded account), then OpenAI, then Kimi
 * (Moonshot). LLM_PROVIDER, when set, names the provider explicitly and a
 * missing key for it is a loud refusal — never a silent fallback. Every
 * production call site goes through makeLlmClient()/hasLlmKey() so the
 * preference can never drift per-surface.
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

export class AnthropicLlmClient implements EmailLlmClient {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor() {
    const cfg = getConfig();
    if (!cfg.anthropicApiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set — the Anthropic LLM client needs it in .env",
      );
    }
    this.client = new Anthropic({ apiKey: cfg.anthropicApiKey });
    this.model = cfg.anthropicLlmModel;
  }

  async generateJson(input: {
    system: string;
    user: string;
  }): Promise<{ text: string; model: string }> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      // Every consumer's system prompt already demands a JSON object and
      // deterministically re-validates the output; the reinforcement here
      // covers models that would otherwise preface JSON with prose.
      system: `${input.system}\n\nRespond with ONLY the JSON object — no prose, no code fences.`,
      messages: [{ role: "user", content: input.user }],
    });
    const text = response.content
      .filter(
        (block): block is Extract<typeof block, { type: "text" }> =>
          block.type === "text",
      )
      .map((block) => block.text)
      .join("");
    return { text: stripJsonFences(text), model: response.model ?? this.model };
  }
}

/**
 * Kimi K3 (Moonshot AI) via its OpenAI-compatible chat-completions API.
 * K3 specifics honored here: sampling params (temperature/top_p) are fixed
 * server-side and must be omitted; reasoning is always on, so effort is
 * pinned LOW — every consumer sends short structured-JSON tasks where max
 * (the default) only burns paid reasoning tokens; reasoning arrives in a
 * separate `reasoning_content` field, so `message.content` is already the
 * clean answer (fence-stripping kept as cheap defense).
 */
export class KimiLlmClient implements EmailLlmClient {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor() {
    const cfg = getConfig();
    if (!cfg.moonshotApiKey) {
      throw new Error(
        "MOONSHOT_API_KEY is not set — the Kimi LLM client needs it in .env",
      );
    }
    this.client = new OpenAI({
      apiKey: cfg.moonshotApiKey,
      baseURL: "https://api.moonshot.ai/v1",
    });
    this.model = cfg.kimiLlmModel;
  }

  async generateJson(input: {
    system: string;
    user: string;
  }): Promise<{ text: string; model: string }> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      response_format: { type: "json_object" },
      reasoning_effort: "low",
      max_completion_tokens: 8192,
      messages: [
        {
          role: "system",
          content: `${input.system}\n\nRespond with ONLY the JSON object — no prose, no code fences.`,
        },
        { role: "user", content: input.user },
      ],
    });
    const text = response.choices[0]?.message?.content ?? "";
    return { text: stripJsonFences(text), model: response.model ?? this.model };
  }
}

/** Models sometimes fence JSON despite instructions; unwrap deterministically. */
function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}

/**
 * True when ANY provider key is configured — the shared precondition every
 * flag-gated LLM surface checks before constructing a client.
 */
export function hasLlmKey(
  cfg?: Pick<AppConfig, "anthropicApiKey" | "openaiApiKey" | "moonshotApiKey">,
): boolean {
  const c = cfg ?? getConfig();
  return Boolean(c.anthropicApiKey ?? c.openaiApiKey ?? c.moonshotApiKey);
}

/** Human-readable name of what hasLlmKey() looks for, for skip notes. */
export const LLM_KEY_HINT =
  "ANTHROPIC_API_KEY, OPENAI_API_KEY, or MOONSHOT_API_KEY";

/**
 * The one production client factory. LLM_PROVIDER, when set, wins and its
 * key must exist (loud refusal otherwise — a forced provider silently
 * swapped for another would falsify every artifact's model attribution).
 * Unset: Anthropic preferred, then OpenAI, then Kimi. Throws when no key
 * is configured (callers gate with hasLlmKey()).
 */
export function makeLlmClient(): EmailLlmClient {
  const cfg = getConfig();
  if (cfg.llmProvider === "anthropic") return new AnthropicLlmClient();
  if (cfg.llmProvider === "openai") return new OpenAiEmailClient();
  if (cfg.llmProvider === "kimi") return new KimiLlmClient();
  if (cfg.anthropicApiKey) return new AnthropicLlmClient();
  if (cfg.openaiApiKey) return new OpenAiEmailClient();
  if (cfg.moonshotApiKey) return new KimiLlmClient();
  throw new Error(
    `no LLM provider key configured — set ${LLM_KEY_HINT} in .env`,
  );
}
