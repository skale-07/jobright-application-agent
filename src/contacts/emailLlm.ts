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
 * Two providers, one preference order: Anthropic when ANTHROPIC_API_KEY is
 * set (the operator's better-funded account), OpenAI otherwise. Every
 * production call site goes through makeLlmClient()/hasLlmKey() so the
 * preference can never drift per-surface.
 */
export interface EmailLlmClient {
  /**
   * Returns the raw model output string (expected to be JSON).
   *
   * `stableContext`, when present, is content that is byte-identical
   * across calls within a session (e.g. the operator's about-me.md).
   * The Anthropic client places it in a prompt-cache breakpoint so
   * repeat calls read it at ~0.1x price; the OpenAI client simply sends
   * it first (OpenAI's automatic prefix caching needs stable-first
   * ordering). Either way the model sees system + stableContext + user
   * in that order — providing it never changes semantics, only cost.
   */
  generateJson(input: {
    system: string;
    user: string;
    stableContext?: string;
  }): Promise<{
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
    stableContext?: string;
  }): Promise<{ text: string; model: string }> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: input.system },
        {
          role: "user",
          // Stable-first so OpenAI's automatic prefix caching can hit.
          content: input.stableContext
            ? `${input.stableContext}\n\n${input.user}`
            : input.user,
        },
      ],
    });
    const text = response.choices[0]?.message?.content ?? "";
    return { text, model: response.model ?? this.model };
  }
}

export class AnthropicLlmClient implements EmailLlmClient {
  private readonly client: Anthropic;
  private readonly model: string;

  /** `model` overrides ANTHROPIC_LLM_MODEL (fast-first tier uses this). */
  constructor(model?: string) {
    const cfg = getConfig();
    if (!cfg.anthropicApiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set — the Anthropic LLM client needs it in .env",
      );
    }
    this.client = new Anthropic({ apiKey: cfg.anthropicApiKey });
    this.model = model ?? cfg.anthropicLlmModel;
  }

  async generateJson(input: {
    system: string;
    user: string;
    stableContext?: string;
  }): Promise<{ text: string; model: string }> {
    const response = await this.client.messages.create(
      buildAnthropicJsonRequest(this.model, input),
    );
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
 * Pure request builder — exported so the caching shape is testable
 * without intercepting the SDK. Without a stable block the request is
 * byte-identical to the pre-caching one. With one, the stable prefix
 * (system + stableContext) ends in a `cache_control` breakpoint: repeat
 * calls within the TTL read it at ~0.1x input price instead of re-paying
 * per form. Below the model's minimum cacheable size the marker is
 * silently ignored — fail-open, never an error.
 */
export function buildAnthropicJsonRequest(
  model: string,
  input: { system: string; user: string; stableContext?: string },
): Anthropic.Messages.MessageCreateParamsNonStreaming {
  // Every consumer's system prompt already demands a JSON object and
  // deterministically re-validates the output; the reinforcement here
  // covers models that would otherwise preface JSON with prose.
  const systemText = `${input.system}\n\nRespond with ONLY the JSON object — no prose, no code fences.`;
  if (!input.stableContext) {
    return {
      model,
      max_tokens: 4096,
      system: systemText,
      messages: [{ role: "user", content: input.user }],
    };
  }
  return {
    model,
    max_tokens: 4096,
    system: systemText,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: input.stableContext,
            cache_control: { type: "ephemeral" },
          },
          { type: "text", text: input.user },
        ],
      },
    ],
  };
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
export function hasLlmKey(cfg?: Pick<AppConfig, "anthropicApiKey" | "openaiApiKey">): boolean {
  const c = cfg ?? getConfig();
  return Boolean(c.anthropicApiKey ?? c.openaiApiKey);
}

/** Human-readable name of what hasLlmKey() looks for, for skip notes. */
export const LLM_KEY_HINT = "ANTHROPIC_API_KEY or OPENAI_API_KEY";

/**
 * The one production client factory: Anthropic preferred, OpenAI fallback.
 * Throws when neither key is configured (callers gate with hasLlmKey()).
 */
export function makeLlmClient(): EmailLlmClient {
  const cfg = getConfig();
  if (cfg.anthropicApiKey) return new AnthropicLlmClient();
  if (cfg.openaiApiKey) return new OpenAiEmailClient();
  throw new Error(
    `no LLM provider key configured — set ${LLM_KEY_HINT} in .env`,
  );
}

/**
 * Cheap first-pass tier for screener prediction (SCREENER_PREDICT_FAST_FIRST).
 * Null unless the operator opted in AND the Anthropic key is present —
 * the fast tier is Anthropic-only (ANTHROPIC_FAST_MODEL, default Haiku);
 * with only an OpenAI key there is no second tier to escalate to, so the
 * caller falls back to today's single-call behavior.
 */
export function makeFastLlmClient(): EmailLlmClient | null {
  const cfg = getConfig();
  if (!cfg.screenerPredictFastFirst) return null;
  if (!cfg.anthropicApiKey) return null;
  return new AnthropicLlmClient(cfg.anthropicFastModel);
}
