import { describe, expect, it } from "vitest";
import { runSidecarTask } from "../../src/agent/sidecarRunner.js";
import { codeVersion } from "../../src/storage/codeVersion.js";

/**
 * Sidecar progress stream (UNIT_CONFIRMED): NDJSON on stderr surfaces
 * live through onProgress while the stdout one-JSON result contract is
 * untouched — the exact failure this guards: progress lines must never
 * corrupt the result parse, and a progress-free sidecar behaves as before.
 */
describe("sidecar progress stream (UNIT_CONFIRMED)", () => {
  const NODE = process.execPath;

  it("progress lines stream via onProgress; stdout result stays one clean JSON", async () => {
    const script = `
      process.stderr.write(JSON.stringify({jaa_progress:1,event:"sidecar_spawned"})+"\\n");
      process.stderr.write("plain stderr noise that is not progress\\n");
      process.stderr.write(JSON.stringify({jaa_progress:1,event:"step",i:1,actions:["click_element"],host:"jobs.ashbyhq.com"})+"\\n");
      process.stdout.write(JSON.stringify({status:"ok",final_url:null}));
    `;
    const events: Array<Record<string, unknown>> = [];
    const out = await runSidecarTask({
      task: { hello: 1 },
      timeoutMs: 10_000,
      graceMs: 1_000,
      commandOverride: { command: NODE, args: ["-e", script] },
      onProgress: (e) => events.push(e),
    });
    expect(JSON.parse(out.trim())).toEqual({ status: "ok", final_url: null });
    expect(events.map((e) => e["event"])).toEqual(["sidecar_spawned", "step"]);
    expect(events[1]!["actions"]).toEqual(["click_element"]);
  });

  it("malformed progress lines and missing onProgress are both harmless", async () => {
    const script = `
      process.stderr.write('{"jaa_progress":1, broken json\\n');
      process.stdout.write(JSON.stringify({ok:true}));
    `;
    // No onProgress at all — original contract.
    const out = await runSidecarTask({
      task: {},
      timeoutMs: 10_000,
      graceMs: 1_000,
      commandOverride: { command: NODE, args: ["-e", script] },
    });
    expect(JSON.parse(out.trim())).toEqual({ ok: true });

    // With onProgress: the malformed line is dropped, never thrown.
    const events: unknown[] = [];
    const out2 = await runSidecarTask({
      task: {},
      timeoutMs: 10_000,
      graceMs: 1_000,
      commandOverride: { command: NODE, args: ["-e", script] },
      onProgress: (e) => events.push(e),
    });
    expect(JSON.parse(out2.trim())).toEqual({ ok: true });
    expect(events).toEqual([]);
  });

  it("codeVersion returns a stable non-empty era stamp", () => {
    const v = codeVersion();
    expect(v.length).toBeGreaterThan(0);
    expect(codeVersion()).toBe(v);
  });
});
