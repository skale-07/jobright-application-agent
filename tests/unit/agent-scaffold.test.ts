import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentAuthoringResultSchema,
  agentAuthoringTaskSchema,
} from "../../src/agent/contract.js";
import {
  assertAgentAuthoringAllowed,
  runAgentAuthoring,
} from "../../src/agent/authorRun.js";
import { parseSessionMode } from "../../src/auth/serviceRegistry.js";
import { resetConfigCache } from "../../src/config/index.js";

const SCRATCH = process.env["CLAUDE_SCRATCHPAD"] ?? os.tmpdir();

describe("CDP_ATTACH session mode (UNIT_CONFIRMED)", () => {
  it("parseSessionMode accepts the new mode and still rejects junk", () => {
    expect(parseSessionMode("CDP_ATTACH")).toBe("CDP_ATTACH");
    expect(parseSessionMode("STORAGE_STATE")).toBe("STORAGE_STATE");
    expect(() => parseSessionMode("YOLO")).toThrow(/Invalid session mode/);
  });
});

describe("agent authoring contract (UNIT_CONFIRMED)", () => {
  it("task schema round-trips and rejects bad tasks", () => {
    const task = agentAuthoringTaskSchema.parse({
      task_version: 1,
      url: "https://boards.greenhouse.io/acme/jobs/1",
      cdp_url: "http://127.0.0.1:9222",
      allowed_domains: ["boards.greenhouse.io"],
      timeout_ms: 60_000,
    });
    expect(task.task_version).toBe(1);
    expect(() =>
      agentAuthoringTaskSchema.parse({ task_version: 2, url: "x" }),
    ).toThrow();
  });

  it("result schema accepts ok/error and rejects malformed candidates", () => {
    expect(
      agentAuthoringResultSchema.parse({
        status: "error",
        reason: "browser-use not installed",
        field_candidates: [],
        warnings: [],
      }).status,
    ).toBe("error");
    expect(() =>
      agentAuthoringResultSchema.parse({
        status: "ok",
        field_candidates: [{ label: "x", type: "text", selector_candidates: [], confidence: 0.5 }],
        warnings: [],
      }),
    ).toThrow(); // empty selector_candidates
  });
});

describe("agent authoring gate + spawn (UNIT_CONFIRMED)", () => {
  let artifactsDir: string;

  beforeEach(() => {
    artifactsDir = path.join(os.tmpdir(), `jaa-agent-${randomUUID()}`);
    process.env.ARTIFACTS_DIR = artifactsDir;
    delete process.env.AGENT_AUTHORING_ENABLED;
    resetConfigCache();
  });

  afterEach(() => {
    delete process.env.AGENT_AUTHORING_ENABLED;
    resetConfigCache();
    fs.rmSync(artifactsDir, { recursive: true, force: true });
  });

  it("refuses by default (fail closed)", () => {
    expect(() => assertAgentAuthoringAllowed()).toThrow(
      /AGENT_AUTHORING_ENABLED=false/,
    );
    return expect(
      runAgentAuthoring({ url: "https://boards.greenhouse.io/acme/jobs/1" }),
    ).rejects.toThrow(/AGENT_AUTHORING_ENABLED=false/);
  });

  it("refuses non-Greenhouse URLs even when enabled", async () => {
    process.env.AGENT_AUTHORING_ENABLED = "true";
    resetConfigCache();
    await expect(
      runAgentAuthoring({ url: "https://evil.example.com/jobs/1" }),
    ).rejects.toThrow(/Greenhouse application URLs only/);
  });

  it("validates sidecar output through the contract (stub sidecar)", async () => {
    process.env.AGENT_AUTHORING_ENABLED = "true";
    resetConfigCache();

    const stub = path.join(SCRATCH, `stub-sidecar-${randomUUID()}.mjs`);
    fs.writeFileSync(
      stub,
      `
      let input = "";
      process.stdin.on("data", (d) => (input += d));
      process.stdin.on("end", () => {
        const task = JSON.parse(input);
        console.log(JSON.stringify({
          status: "ok",
          field_candidates: [
            { label: "First name", type: "text",
              selector_candidates: ["#first_name", '[name="job_application[first_name]"]'],
              confidence: 0.8 },
          ],
          warnings: ["stub sidecar: " + task.url],
        }));
      });
      `,
    );
    try {
      const report = await runAgentAuthoring({
        url: "https://boards.greenhouse.io/acme/jobs/1",
        commandOverride: { command: process.execPath, args: [stub] },
      });
      expect(report.status).toBe("ok");
      expect(report.field_candidate_count).toBe(1);
      expect(report.output_path).toBeTruthy();
      const onDisk = JSON.parse(fs.readFileSync(report.output_path!, "utf8"));
      expect(onDisk.note).toMatch(/Human review required/);
      expect(report.output_path).toContain("agent-authoring");
    } finally {
      fs.unlinkSync(stub);
    }
  });

  it("rejects malformed sidecar output instead of trusting it", async () => {
    process.env.AGENT_AUTHORING_ENABLED = "true";
    resetConfigCache();
    const stub = path.join(SCRATCH, `stub-bad-${randomUUID()}.mjs`);
    fs.writeFileSync(
      stub,
      `process.stdin.resume(); process.stdin.on("end", () => console.log("not json"));`,
    );
    try {
      const report = await runAgentAuthoring({
        url: "https://boards.greenhouse.io/acme/jobs/1",
        commandOverride: { command: process.execPath, args: [stub] },
      });
      expect(report.status).toBe("invalid_output");
      expect(report.reason).toMatch(/contract validation/);
      expect(report.output_path).toBeNull();
    } finally {
      fs.unlinkSync(stub);
    }
  });

  it("the real python sidecar reports browser-use missing (inert by default)", async () => {
    process.env.AGENT_AUTHORING_ENABLED = "true";
    resetConfigCache();
    // Only meaningful when python3 exists in this environment.
    const report = await runAgentAuthoring({
      url: "https://boards.greenhouse.io/acme/jobs/1",
      commandOverride: {
        command: "python3",
        args: [path.join(process.cwd(), "agent", "jobright_agent", "author.py")],
      },
    }).catch((err: Error) => err);
    if (report instanceof Error) {
      // python3 unavailable — spawn failure is acceptable for this check.
      expect(String(report.message)).toMatch(/spawn|no output/i);
      return;
    }
    expect(report.status).toBe("error");
    expect(report.reason).toMatch(/browser-use not installed/);
  });
});
