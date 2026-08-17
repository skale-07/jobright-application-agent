import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAnthropicJsonRequest, type EmailLlmClient } from "../../src/contacts/emailLlm.js";
import { predictAnswersForQuestions } from "../../src/applications/screenerPredictionLlm.js";
import { resetConfigCache } from "../../src/config/index.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";

/**
 * Prompt-cache plumbing (operator directive 2026-08-17: partition the
 * predictor payload — stable prefix cached, per-batch suffix follows).
 * These tests pin the REQUEST SHAPE, so the cache either works or the
 * request is visibly wrong; no network, no key, no live model.
 */
describe("buildAnthropicJsonRequest (UNIT_CONFIRMED)", () => {
  it("without stableContext the request is the plain pre-caching shape", () => {
    const req = buildAnthropicJsonRequest("claude-test", {
      system: "SYS",
      user: '{"q":1}',
    });
    expect(req.system).toMatch(/^SYS\n\nRespond with ONLY the JSON object/);
    expect(req.messages).toEqual([{ role: "user", content: '{"q":1}' }]);
  });

  it("with stableContext the stable block ends in a cache breakpoint and precedes the variable block", () => {
    const req = buildAnthropicJsonRequest("claude-test", {
      system: "SYS",
      user: '{"questions":[]}',
      stableContext: '{"candidate_context":"about me text"}',
    });
    const content = req.messages[0]!.content as Array<{
      type: string;
      text: string;
      cache_control?: { type: string };
    }>;
    expect(content).toHaveLength(2);
    // Stable first — a cache is a prefix match; volatile content after it.
    expect(content[0]!.text).toContain("candidate_context");
    expect(content[0]!.cache_control).toEqual({ type: "ephemeral" });
    // The per-batch payload carries NO marker: caching it would write a
    // new entry per form and never read one.
    expect(content[1]!.text).toBe('{"questions":[]}');
    expect(content[1]!.cache_control).toBeUndefined();
  });
});

describe("predictor splits stable and per-batch context (UNIT_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  let privDir: string;
  let priorPrivate: string | undefined;
  beforeEach(() => {
    process.env.SCREENER_PREDICT_LLM_ENABLED = "true";
    priorPrivate = process.env.PRIVATE_DIR;
    privDir = path.join(os.tmpdir(), `cache-priv-${randomUUID()}`);
    fs.mkdirSync(path.join(privDir, "candidate"), { recursive: true });
    fs.writeFileSync(
      path.join(privDir, "candidate", "about-me.md"),
      "I am a Baltimore-based CS student who builds browser automation and enjoys embedded systems work on weekends.",
    );
    process.env.PRIVATE_DIR = privDir;
    resetConfigCache();
  });
  afterEach(() => {
    if (priorPrivate === undefined) delete process.env.PRIVATE_DIR;
    else process.env.PRIVATE_DIR = priorPrivate;
    fs.rmSync(privDir, { recursive: true, force: true });
    resetConfigCache();
  });

  it("about-me rides in stableContext; questions ride in the variable user payload", async () => {
    let seen: { system: string; user: string; stableContext?: string } | null =
      null;
    const capture: EmailLlmClient = {
      async generateJson(input) {
        seen = input;
        return {
          text: JSON.stringify({
            predictions: [
              {
                label: "Which shift can you work?",
                answer: "Night",
                key: "shift",
                basis: "test",
              },
            ],
          }),
          model: "stub",
        };
      },
    };
    const out = await predictAnswersForQuestions(
      [{ id: "f1", label: "Which shift can you work?", options: ["Day", "Night"] }],
      capture,
    );
    expect(out.get("f1")?.value).toBe("Night");
    expect(seen).not.toBeNull();
    const got = seen!;
    // The stable block carries the about-me verbatim…
    expect(got.stableContext).toContain("Baltimore-based CS student");
    // …and the variable payload carries the questions but NOT the about-me,
    // so editing a question never invalidates the cached prefix.
    expect(got.user).toContain("Which shift can you work?");
    expect(got.user).not.toContain("Baltimore-based CS student");
  });
});
