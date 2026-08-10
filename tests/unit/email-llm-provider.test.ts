import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigCache } from "../../src/config/index.js";
import {
  AnthropicLlmClient,
  OpenAiEmailClient,
  hasLlmKey,
  makeLlmClient,
} from "../../src/contacts/emailLlm.js";

/**
 * Provider selection at the one LLM boundary: Anthropic preferred when its
 * key exists, OpenAI as fallback, hard refusal with neither. No test ever
 * calls out — construction only. UNIT_CONFIRMED.
 */
describe("LLM provider factory (UNIT_CONFIRMED)", () => {
  let savedAnthropic: string | undefined;
  let savedOpenai: string | undefined;

  beforeEach(() => {
    savedAnthropic = process.env.ANTHROPIC_API_KEY;
    savedOpenai = process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    resetConfigCache();
  });

  afterEach(() => {
    if (savedAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedAnthropic;
    if (savedOpenai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedOpenai;
    resetConfigCache();
  });

  it("hasLlmKey is false with neither key, true with either", () => {
    expect(hasLlmKey()).toBe(false);

    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key-000000000000";
    resetConfigCache();
    expect(hasLlmKey()).toBe(true);

    delete process.env.OPENAI_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key-000000000000";
    resetConfigCache();
    expect(hasLlmKey()).toBe(true);
  });

  it("makeLlmClient refuses with neither key, naming both env vars", () => {
    expect(() => makeLlmClient()).toThrow(/ANTHROPIC_API_KEY or OPENAI_API_KEY/);
  });

  it("prefers Anthropic when both keys are present", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key-000000000000";
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key-000000000000";
    resetConfigCache();
    expect(makeLlmClient()).toBeInstanceOf(AnthropicLlmClient);
  });

  it("falls back to OpenAI when only that key is present", () => {
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key-000000000000";
    resetConfigCache();
    expect(makeLlmClient()).toBeInstanceOf(OpenAiEmailClient);
  });
});
