import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AlreadyRunningError,
  defaultConsoleRunnerInvocation,
  RunManager,
  type SseFrame,
} from "../../src/console/runManager.js";

/**
 * Scripted `node -e` children play the runner's role: the manager only
 * sees stdio + exit codes, so these fakes exercise the real demux,
 * confirmation relay, persistence, and lifecycle paths.
 */

const HELLO_REPORT_SCRIPT = `
const fs = require("fs");
const args = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
console.log(JSON.stringify({ jaa_frame: "hello", kind: process.argv[1], pid: process.pid, gates: { FORM_FILL_ENABLED: process.env.FORM_FILL_ENABLED === "true" } }));
console.log("plain progress line");
console.error("stderr noise");
fs.writeFileSync(args.report_path, JSON.stringify({ ok: true }));
console.log(JSON.stringify({ jaa_frame: "report", report: { ok: true } }));
process.exit(0);
`;

const CONFIRM_SCRIPT = `
const fs = require("fs");
const args = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const summary = { application_id: "a", company: "Acme", role: "SWE", url: "https://jobs.lever.co/a/b/apply", attempt: 1, resume_sha256: "f".repeat(64), resume_size_bytes: 9, plan: { fillable_count: 2, skipped_count: 0, review_required_count: 0 } };
console.log(JSON.stringify({ jaa_frame: "confirm_request", confirmation_id: "c-1", summary, timeout_ms: 60000 }));
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  const nl = buf.indexOf("\\n");
  if (nl < 0) return;
  const m = JSON.parse(buf.slice(0, nl));
  fs.writeFileSync(args.report_path, JSON.stringify({ accepted: m.accept }));
  console.log(JSON.stringify({ jaa_frame: "report", report: { accepted: m.accept } }));
  process.exit(0);
});
process.stdin.on("end", () => process.exit(1));
`;

const FAIL_SCRIPT = `
console.log(JSON.stringify({ jaa_frame: "error", message: "boom" }));
process.exit(3);
`;

const SLEEP_SCRIPT = `
console.log("sleeping");
setTimeout(() => process.exit(0), 60000);
`;

function manager(
  tmpDir: string,
  script: string,
  options?: { confirmationTimeoutMs?: number; runTimeoutMs?: number },
): RunManager {
  return new RunManager({
    runsDir: path.join(tmpDir, "runs"),
    commandOverride: { command: process.execPath, args: ["-e", script] },
    ...(options?.confirmationTimeoutMs
      ? { confirmationTimeoutMs: options.confirmationTimeoutMs }
      : {}),
    ...(options?.runTimeoutMs ? { runTimeoutMs: options.runTimeoutMs } : {}),
  });
}

async function until(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("RunManager (UNIT_CONFIRMED via scripted children)", () => {
  let tmpDir: string;
  let managers: RunManager[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-runmgr-"));
    managers = [];
  });

  afterEach(() => {
    for (const m of managers) m.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function track(m: RunManager): RunManager {
    managers.push(m);
    return m;
  }

  it("default runner uses node + resolved tsx/cli (not bare .bin/tsx)", () => {
    // Windows ENOENT (-4058) when spawning node_modules/.bin/tsx without
    // an extension; node + tsx/cli is the portable form.
    const inv = defaultConsoleRunnerInvocation();
    expect(inv.command).toBe(process.execPath);
    expect(inv.args[0]).toMatch(/tsx[/\\].*cli/i);
    expect(inv.args[1]).toMatch(/runner\.ts$/);
    expect(inv.command).not.toMatch(/\.bin[/\\]tsx$/i);
    expect(fs.existsSync(inv.args[0]!)).toBe(true);
  });

  it("happy path: hello gates captured, logs streamed with seqs, report demuxed, succeeded", async () => {
    const m = track(manager(tmpDir, HELLO_REPORT_SCRIPT));
    const frames: SseFrame[] = [];
    const record = m.start({ kind: "pipeline", params: {}, optIns: {} });
    m.subscribe(record.id, (f) => frames.push(f));
    await until(() => m.get(record.id)?.status === "succeeded");

    const done = m.get(record.id)!;
    expect(done.exit_code).toBe(0);
    expect(done.report).toEqual({ ok: true });
    expect(done.gates).toMatchObject({ FORM_FILL_ENABLED: false });

    const logs = m.logsAfter(record.id, 0);
    expect(logs.map((l) => l.line)).toContain("plain progress line");
    expect(logs.map((l) => l.line)).toContain("stderr noise");
    // Control frames never appear as log lines.
    expect(logs.some((l) => l.line.includes("jaa_frame"))).toBe(false);
    expect(logs.map((l) => l.seq)).toEqual([...logs.map((l) => l.seq)].sort((a, b) => a - b));

    // Persistence: meta + report + logs on disk, list() finds it after the fact.
    const dir = path.join(tmpDir, "runs", record.id);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")).status).toBe(
      "succeeded",
    );
    expect(JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8"))).toEqual({
      ok: true,
    });
    expect(m.list()[0]?.id).toBe(record.id);
  });

  it("confirmation round-trip: awaiting status, operator accept reaches the child", async () => {
    const m = track(manager(tmpDir, CONFIRM_SCRIPT));
    const record = m.start({ kind: "submit", params: {}, optIns: {} });
    await until(() => m.get(record.id)?.status === "awaiting_confirmation");

    const pending = m.get(record.id)!.pending_confirmation!;
    expect(pending.confirmation_id).toBe("c-1");
    expect(pending.summary.company).toBe("Acme");

    expect(m.confirm(record.id, "wrong-id", true)).toBe("stale");
    expect(m.confirm(record.id, "c-1", true)).toBe("accepted");
    await until(() => m.get(record.id)?.status === "succeeded");
    expect(m.get(record.id)!.report).toEqual({ accepted: true });
    // Answered — nothing pending anymore.
    expect(m.confirm(record.id, "c-1", true)).toBe("none");
  });

  it("operator decline reaches the child as accept:false", async () => {
    const m = track(manager(tmpDir, CONFIRM_SCRIPT));
    const record = m.start({ kind: "submit", params: {}, optIns: {} });
    await until(() => m.get(record.id)?.status === "awaiting_confirmation");
    expect(m.confirm(record.id, "c-1", false)).toBe("accepted");
    await until(() => m.get(record.id)?.status === "succeeded");
    expect(m.get(record.id)!.report).toEqual({ accepted: false });
  });

  it("parent auto-decline timer fails closed when no operator answers", async () => {
    const m = track(manager(tmpDir, CONFIRM_SCRIPT, { confirmationTimeoutMs: 300 }));
    const record = m.start({ kind: "submit", params: {}, optIns: {} });
    await until(() => m.get(record.id)?.status === "awaiting_confirmation");
    // Nobody answers — the parent declines on its own.
    await until(() => m.get(record.id)?.status === "succeeded");
    expect(m.get(record.id)!.report).toEqual({ accepted: false });
  });

  it("nonzero exit without a report is failed with the error frame captured", async () => {
    const m = track(manager(tmpDir, FAIL_SCRIPT));
    const record = m.start({ kind: "nav", params: {}, optIns: {} });
    await until(() => m.get(record.id)?.status === "failed");
    const done = m.get(record.id)!;
    expect(done.exit_code).toBe(3);
    expect(done.error).toBe("boom");
  });

  it("exit 0 WITHOUT a report frame is still failed (no silent success)", async () => {
    const m = track(manager(tmpDir, `console.log("did nothing"); process.exit(0);`));
    const record = m.start({ kind: "pipeline", params: {}, optIns: {} });
    await until(() => m.get(record.id)?.status === "failed");
    expect(m.get(record.id)!.error).toMatch(/no report was produced/);
  });

  it("one run at a time: second start throws AlreadyRunning; cancel tears down", async () => {
    const m = track(manager(tmpDir, SLEEP_SCRIPT));
    const record = m.start({ kind: "pipeline", params: {}, optIns: {} });
    await until(() => m.get(record.id)?.status === "running");
    expect(() => m.start({ kind: "nav", params: {}, optIns: {} })).toThrow(
      AlreadyRunningError,
    );
    expect(m.cancel(record.id)).toBe(true);
    await until(() => m.get(record.id)?.status === "canceled" && m.get(record.id)?.ended_at !== null);
    // After teardown a new run may start.
    const second = m.start({ kind: "nav", params: {}, optIns: {} });
    expect(second.id).not.toBe(record.id);
  });

  it("run timeout SIGKILLs and records timed_out", async () => {
    const m = track(manager(tmpDir, SLEEP_SCRIPT, { runTimeoutMs: 300 }));
    const record = m.start({ kind: "pipeline", params: {}, optIns: {} });
    await until(() => m.get(record.id)?.status === "timed_out" && m.get(record.id)?.ended_at !== null);
    expect(m.get(record.id)!.exit_code).not.toBe(0);
  });

  it("a report written immediately before exit is never lost to the exit race", async () => {
    // The child writes the frame and exits in the same tick — with an
    // "exit" listener this raced and reported a false failure.
    const racy = `
      const fs = require("fs");
      const args = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
      fs.writeFileSync(args.report_path, JSON.stringify({ ok: 1 }));
      process.stdout.write(JSON.stringify({ jaa_frame: "report", report: { ok: 1 } }) + "\\n");
      process.exit(0);
    `;
    for (let i = 0; i < 5; i++) {
      const m = track(manager(tmpDir, racy));
      const record = m.start({ kind: "pipeline", params: {}, optIns: {} });
      await until(() => m.get(record.id)?.ended_at != null);
      expect(m.get(record.id)!.status, `iteration ${i}`).toBe("succeeded");
      expect(m.get(record.id)!.report).toEqual({ ok: 1 });
    }
  });

  it("falls back to report.json when the frame never arrives", async () => {
    // Writes the report file but no frame — exit 0 must still succeed.
    const fileOnly = `
      const fs = require("fs");
      const args = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
      fs.writeFileSync(args.report_path, JSON.stringify({ from: "disk" }));
      process.exit(0);
    `;
    const m = track(manager(tmpDir, fileOnly));
    const record = m.start({ kind: "nav", params: {}, optIns: {} });
    await until(() => m.get(record.id)?.ended_at != null);
    expect(m.get(record.id)!.status).toBe("succeeded");
    expect(m.get(record.id)!.report).toEqual({ from: "disk" });
  });

  it("a failed spawn releases the active slot instead of wedging the manager", async () => {
    const m = new RunManager({
      runsDir: path.join(tmpDir, "runs"),
      commandOverride: {
        command: path.join(tmpDir, "does-not-exist"),
        args: [],
      },
    });
    track(m);
    const record = m.start({ kind: "pipeline", params: {}, optIns: {} });
    await until(() => m.get(record.id)?.status === "failed");
    expect(m.activeRun).toBeNull();
    // A later run can start — the slot was released.
    expect(() => m.start({ kind: "nav", params: {}, optIns: {} })).not.toThrow();
  });

  it("run ids that are not run-<uuid> never reach the filesystem", () => {
    const m = track(manager(tmpDir, HELLO_REPORT_SCRIPT));
    for (const bad of [
      "../../etc/passwd",
      "run-../../secrets",
      "..",
      "run-not-a-uuid",
      "",
    ]) {
      expect(m.get(bad), bad).toBeUndefined();
      expect(m.logsAfter(bad, 0), bad).toEqual([]);
    }
  });

  it("answering a confirmation after the child died does not throw", async () => {
    const m = track(manager(tmpDir, CONFIRM_SCRIPT));
    const record = m.start({ kind: "submit", params: {}, optIns: {} });
    await until(() => m.get(record.id)?.status === "awaiting_confirmation");
    m.cancel(record.id);
    await until(() => m.get(record.id)?.ended_at != null);
    // Stdin is gone; the write must be swallowed, not crash the console.
    expect(() => m.confirm(record.id, "c-1", true)).not.toThrow();
  });

  it("logsAfter honors after_seq for the poll fallback", async () => {
    const m = track(manager(tmpDir, HELLO_REPORT_SCRIPT));
    const record = m.start({ kind: "pipeline", params: {}, optIns: {} });
    await until(() => m.get(record.id)?.status === "succeeded");
    const all = m.logsAfter(record.id, 0);
    expect(all.length).toBeGreaterThanOrEqual(2);
    const tail = m.logsAfter(record.id, all[0]!.seq);
    expect(tail.length).toBe(all.length - 1);
  });
});
