import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigCache } from "../../src/config/index.js";
import {
  AnthropicLlmClient,
  KimiLlmClient,
  OpenAiEmailClient,
  hasLlmKey,
  makeLlmClient,
} from "../../src/contacts/emailLlm.js";

/**
 * Provider selection at the one LLM boundary: Anthropic preferred when its
 * key exists, then OpenAI, then Kimi (Moonshot); LLM_PROVIDER forces one
 * provider and refuses loudly when its key is missing. No test ever calls
 * out — construction only. UNIT_CONFIRMED.
 */
const KEY_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "MOONSHOT_API_KEY",
  "LLM_PROVIDER",
] as const;

describe("LLM provider factory (UNIT_CONFIRMED)", () => {
  const saved: Partial<Record<(typeof KEY_VARS)[number], string | undefined>> =
    {};

  beforeEach(() => {
    for (const k of KEY_VARS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    resetConfigCache();
  });

  afterEach(() => {
    for (const k of KEY_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetConfigCache();
  });

  it("hasLlmKey is false with no key, true with any one of the three", () => {
    expect(hasLlmKey()).toBe(false);

    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key-000000000000";
    resetConfigCache();
    expect(hasLlmKey()).toBe(true);

    delete process.env.OPENAI_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key-000000000000";
    resetConfigCache();
    expect(hasLlmKey()).toBe(true);

    delete process.env.ANTHROPIC_API_KEY;
    process.env.MOONSHOT_API_KEY = "sk-test-not-a-real-moonshot-key-0000";
    resetConfigCache();
    expect(hasLlmKey()).toBe(true);
  });

  it("makeLlmClient refuses with no key, naming all three env vars", () => {
    expect(() => makeLlmClient()).toThrow(
      /ANTHROPIC_API_KEY, OPENAI_API_KEY, or MOONSHOT_API_KEY/,
    );
  });

  it("prefers Anthropic when all three keys are present", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key-000000000000";
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key-000000000000";
    process.env.MOONSHOT_API_KEY = "sk-test-not-a-real-moonshot-key-0000";
    resetConfigCache();
    expect(makeLlmClient()).toBeInstanceOf(AnthropicLlmClient);
  });

  it("falls back to OpenAI when only that key is present", () => {
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key-000000000000";
    resetConfigCache();
    expect(makeLlmClient()).toBeInstanceOf(OpenAiEmailClient);
  });

  it("falls back to Kimi when only the Moonshot key is present", () => {
    process.env.MOONSHOT_API_KEY = "sk-test-not-a-real-moonshot-key-0000";
    resetConfigCache();
    expect(makeLlmClient()).toBeInstanceOf(KimiLlmClient);
  });

  it("Kimi never outranks OpenAI in the default order", () => {
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key-000000000000";
    process.env.MOONSHOT_API_KEY = "sk-test-not-a-real-moonshot-key-0000";
    resetConfigCache();
    expect(makeLlmClient()).toBeInstanceOf(OpenAiEmailClient);
  });

  it("LLM_PROVIDER=kimi forces Kimi past higher-preference keys", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key-000000000000";
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key-000000000000";
    process.env.MOONSHOT_API_KEY = "sk-test-not-a-real-moonshot-key-0000";
    process.env.LLM_PROVIDER = "kimi";
    resetConfigCache();
    expect(makeLlmClient()).toBeInstanceOf(KimiLlmClient);
  });

  it("LLM_PROVIDER=openai forces OpenAI past the Anthropic preference", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key-000000000000";
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key-000000000000";
    process.env.LLM_PROVIDER = "openai";
    resetConfigCache();
    expect(makeLlmClient()).toBeInstanceOf(OpenAiEmailClient);
  });

  it("a forced provider with a missing key refuses — no silent fallback", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key-000000000000";
    process.env.LLM_PROVIDER = "kimi";
    resetConfigCache();
    expect(() => makeLlmClient()).toThrow(/MOONSHOT_API_KEY is not set/);
  });

  it("an unknown LLM_PROVIDER value is rejected at config parse", () => {
    process.env.MOONSHOT_API_KEY = "sk-test-not-a-real-moonshot-key-0000";
    process.env.LLM_PROVIDER = "grok";
    resetConfigCache();
    expect(() => makeLlmClient()).toThrow();
  });
});
