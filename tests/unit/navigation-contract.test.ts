import { describe, expect, it } from "vitest";
import {
  agentNavigateResultSchema,
  agentNavigateTaskSchema,
} from "../../src/agent/contract.js";
import { runSidecarTask } from "../../src/agent/sidecarRunner.js";

const BASE_TASK = {
  task_version: 1,
  task_type: "navigate",
  goal: "reach the employer application form",
  start_url: "https://jobright.ai/jobs/info/6a76229767a1ad0bc53c8e9f",
  cdp_url: "http://127.0.0.1:9222",
  allowed_domains: ["jobright.ai", "jobs.lever.co"],
  max_steps: 25,
  timeout_ms: 180_000,
};

const BASE_RESULT = {
  status: "ok",
  final_url: "https://jobs.lever.co/acme/a1b2c3d4-e5f6-7890-abcd-ef1234567890/apply",
  wall: "none",
  steps_used: 3,
  domains_visited: ["jobright.ai", "jobs.lever.co"],
  notes: [],
};

describe("navigate contract (N1, UNIT_CONFIRMED)", () => {
  it("accepts a minimal task with credentials defaulting closed", () => {
    const task = agentNavigateTaskSchema.parse(BASE_TASK);
    expect(task.credentials.available).toBe(false);
    expect(task.gmail_available).toBe(false);
  });

  it("rejects step/timeout values over the schema caps", () => {
    expect(() =>
      agentNavigateTaskSchema.parse({ ...BASE_TASK, max_steps: 41 }),
    ).toThrow();
    expect(() =>
      agentNavigateTaskSchema.parse({ ...BASE_TASK, timeout_ms: 300_001 }),
    ).toThrow();
  });

  it("accepts a continuation with an injected verification code", () => {
    const task = agentNavigateTaskSchema.parse({
      ...BASE_TASK,
      resume: {
        prior_run_id: "nav-1",
        prior_final_url: "https://jobs.ashbyhq.com/acme/login",
        injected: { kind: "verification_code", code: "482193" },
      },
    });
    expect(task.resume?.injected.kind).toBe("verification_code");
  });

  it("accepts ok / needs_input / error results with their invariants", () => {
    expect(agentNavigateResultSchema.parse(BASE_RESULT).status).toBe("ok");
    const needsInput = agentNavigateResultSchema.parse({
      ...BASE_RESULT,
      status: "needs_input",
      final_url: "https://jobs.ashbyhq.com/acme/verify",
      wall: "auth",
      need: {
        kind: "verification_email",
        sent_to: "candidate@example.com",
        requested_at: "2026-08-07T00:00:00Z",
      },
    });
    expect(needsInput.need?.kind).toBe("verification_email");
  });

  it("rejects needs_input without a need payload", () => {
    expect(() =>
      agentNavigateResultSchema.parse({
        ...BASE_RESULT,
        status: "needs_input",
        wall: "auth",
      }),
    ).toThrow(/needs_input requires/);
  });

  it("rejects ok with a null final_url", () => {
    expect(() =>
      agentNavigateResultSchema.parse({
        ...BASE_RESULT,
        final_url: null,
      }),
    ).toThrow(/non-null final_url/);
  });
});

describe("runSidecarTask (N1, UNIT_CONFIRMED)", () => {
  it("delivers the task on stdin and returns stdout", async () => {
    const stdout = await runSidecarTask({
      task: { hello: "world" },
      timeoutMs: 5_000,
      graceMs: 1_000,
      commandOverride: {
        command: "node",
        args: [
          "-e",
          "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(d));",
        ],
      },
    });
    expect(JSON.parse(stdout.trim())).toEqual({ hello: "world" });
  });

  it("tolerates non-zero exit when stdout carries a result", async () => {
    const stdout = await runSidecarTask({
      task: {},
      timeoutMs: 5_000,
      graceMs: 1_000,
      commandOverride: {
        command: "node",
        args: ["-e", "console.log(JSON.stringify({status:'error'}));process.exit(3);"],
      },
    });
    expect(JSON.parse(stdout.trim()).status).toBe("error");
  });

  it("rejects on empty stdout", async () => {
    await expect(
      runSidecarTask({
        task: {},
        timeoutMs: 5_000,
        graceMs: 1_000,
        commandOverride: {
          command: "node",
          args: ["-e", "console.error('boom');process.exit(1);"],
        },
      }),
    ).rejects.toThrow(/no output/);
  });

  it("the python navigate stub emits a navigate-shaped error (contract round trip)", async () => {
    // No python/browser-use dependency: replay the stub's exact output.
    const stubOutput = {
      status: "error",
      final_url: null,
      wall: "budget",
      steps_used: 0,
      domains_visited: [],
      notes: [],
      reason: "navigate not implemented (N1 stub)",
    };
    const parsed = agentNavigateResultSchema.parse(stubOutput);
    expect(parsed.wall).toBe("budget");
  });
});
