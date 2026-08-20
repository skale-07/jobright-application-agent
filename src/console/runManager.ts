import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { logger } from "../logging/logger.js";
import { redactObject } from "../logging/redaction.js";
import type { SubmitConfirmationSummary } from "../applications/submitConfirmation.js";
import { parseFrame, serializeFrame } from "./frames.js";
import {
  composeChildEnv,
  grantedAndDenied,
  readCeiling,
  type ComposeContext,
  type FlagOptIns,
} from "./flagCeiling.js";

/**
 * Build the OS-portable command that runs the console runner under tsx.
 * Do not spawn `node_modules/.bin/tsx` — on Windows that path has no
 * extension and libuv reports ENOENT (exit -4058). `node` + the resolved
 * `tsx/cli` entry works on every platform without shell:true.
 */
export function defaultConsoleRunnerInvocation(): {
  command: string;
  args: string[];
} {
  const require = createRequire(import.meta.url);
  let tsxCli: string;
  try {
    tsxCli = require.resolve("tsx/cli");
  } catch {
    // Fallback when package exports are unusual — still portable.
    tsxCli = path.join(
      process.cwd(),
      "node_modules",
      "tsx",
      "dist",
      "cli.mjs",
    );
  }
  return {
    command: process.execPath,
    args: [tsxCli, path.join("src", "console", "runner.ts")],
  };
}
/**
 * One child run at a time: spawn a runner process with a
 * ceiling-composed env, stream its stdout/stderr as seq-numbered log
 * lines (ring buffer + logs.jsonl on disk), lift control frames out of
 * the stream, relay submit confirmations between the child's stdio and
 * the web UI, and persist meta/report so history survives a server
 * restart. Parent-side fail-closed: its own confirmation timer declines
 * independently of the child's; killing the parent EOFs the child's
 * stdin, which the child treats as decline.
 */

export type RunKind =
  | "pipeline"
  | "nav"
  | "submit"
  | "discover"
  | "automation"
  // X6 console-first outreach: insider-email triage, per-contact email
  // generation, and Gmail draft creation — each a bounded child run so no
  // CLI is ever required for the outreach pipeline.
  | "contacts"
  | "email"
  | "gmail_draft";
export type RunStatus =
  | "pending"
  | "running"
  | "awaiting_confirmation"
  | "succeeded"
  | "failed"
  | "canceled"
  | "timed_out";

const ACTIVE: RunStatus[] = ["pending", "running", "awaiting_confirmation"];

export type RunRecord = {
  id: string;
  kind: RunKind;
  params: Record<string, unknown>;
  granted_flags: string[];
  denied_flags: string[];
  status: RunStatus;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  exit_code: number | null;
  error: string | null;
  gates: Record<string, boolean> | null;
  pending_confirmation: {
    confirmation_id: string;
    summary: SubmitConfirmationSummary;
    requested_at: string;
    expires_at: string;
  } | null;
  report: unknown;
  log_seq: number;
};

export type LogLine = { seq: number; stream: "stdout" | "stderr"; line: string };

export type SseFrame =
  | { event: "status"; data: { status: RunStatus; run: RunRecord } }
  | { event: "log"; data: LogLine }
  | {
      event: "confirm";
      data: {
        confirmation_id: string;
        summary: SubmitConfirmationSummary;
        expires_at: string;
      };
    }
  | { event: "report"; data: { report: unknown } }
  | { event: "end"; data: { status: RunStatus; exit_code: number | null } };

export class AlreadyRunningError extends Error {
  constructor(activeId: string) {
    super(`another run is active (${activeId}) — one console run at a time`);
    this.name = "AlreadyRunningError";
  }
}

const RING_LIMIT = 5000;

/**
 * Run ids are minted here (`run-<uuid>`) and then arrive back as URL path
 * params that index into the runs directory — so anything that is not
 * exactly that shape must never reach path.join.
 */
const RUN_ID_PATTERN =
  /^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isRunId(value: string): boolean {
  return RUN_ID_PATTERN.test(value);
}

type SpawnLike = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcess;

type ActiveRun = {
  record: RunRecord;
  child: ChildProcess;
  logs: LogLine[];
  subscribers: Set<(frame: SseFrame) => void>;
  confirmTimer: NodeJS.Timeout | null;
  runTimer: NodeJS.Timeout;
  stdoutBuf: string;
  stderrBuf: string;
  reportSeen: boolean;
};

export class RunManager {
  private readonly spawnImpl: SpawnLike;
  private readonly runsDir: string;
  private readonly confirmationTimeoutMs: number;
  private readonly runTimeoutMs: number;
  private readonly commandOverride: { command: string; args: string[] } | null;
  private active: ActiveRun | null = null;

  constructor(deps: {
    runsDir: string;
    spawnImpl?: SpawnLike;
    confirmationTimeoutMs?: number;
    runTimeoutMs?: number;
    /** Test seam: replaces the tsx-runner command entirely. */
    commandOverride?: { command: string; args: string[] };
  }) {
    this.spawnImpl = deps.spawnImpl ?? (nodeSpawn as unknown as SpawnLike);
    this.runsDir = deps.runsDir;
    this.confirmationTimeoutMs = deps.confirmationTimeoutMs ?? 5 * 60 * 1000;
    this.runTimeoutMs = deps.runTimeoutMs ?? 30 * 60 * 1000;
    this.commandOverride = deps.commandOverride ?? null;
  }

  get activeRun(): RunRecord | null {
    return this.active?.record ?? null;
  }

  start(input: {
    kind: RunKind;
    params: Record<string, unknown>;
    optIns: FlagOptIns;
    /** Only set for an armed automation run — relaxes forced submit safety. */
    context?: ComposeContext;
  }): RunRecord {
    if (this.active && ACTIVE.includes(this.active.record.status)) {
      throw new AlreadyRunningError(this.active.record.id);
    }
    const id = `run-${randomUUID()}`;
    const dir = path.join(this.runsDir, id);
    fs.mkdirSync(dir, { recursive: true });

    const ceiling = readCeiling();
    const { granted, denied } = grantedAndDenied(ceiling, input.optIns);
    const record: RunRecord = {
      id,
      kind: input.kind,
      params: input.params,
      granted_flags: granted,
      denied_flags: denied,
      status: "pending",
      created_at: new Date().toISOString(),
      started_at: null,
      ended_at: null,
      exit_code: null,
      error: null,
      gates: null,
      pending_confirmation: null,
      report: null,
      log_seq: 0,
    };

    const argsPath = path.join(dir, "args.json");
    const reportPath = path.join(dir, "report.json");
    fs.writeFileSync(
      argsPath,
      JSON.stringify({ ...input.params, report_path: reportPath }, null, 2),
    );

    const env = composeChildEnv(process.env, ceiling, input.optIns, input.context ?? {});
    const { command, args } =
      this.commandOverride ?? defaultConsoleRunnerInvocation();

    let child: ChildProcess;
    try {
      child = this.spawnImpl(
        command,
        [...args, input.kind, "--args", argsPath],
        { cwd: process.cwd(), env, stdio: ["pipe", "pipe", "pipe"] },
      );
    } catch (err) {
      record.status = "failed";
      record.error = err instanceof Error ? err.message : String(err);
      record.ended_at = new Date().toISOString();
      this.persistMeta(record);
      return record;
    }

    const active: ActiveRun = {
      record,
      child,
      logs: [],
      subscribers: new Set(),
      confirmTimer: null,
      runTimer: setTimeout(() => this.timeOut(active), this.runTimeoutMs),
      stdoutBuf: "",
      stderrBuf: "",
      reportSeen: false,
    };
    this.active = active;

    child.once("error", (err) => {
      record.error = err.message;
      // Route through onExit so the active slot is released — otherwise a
      // failed spawn would block every later run and leave subscribers on
      // a stream that never ends.
      this.onExit(active, null);
    });
    // A child that dies mid-write (cancel/kill) can EPIPE on stdin; that is
    // an expected outcome, not a reason to take the console down.
    child.stdin?.on("error", () => undefined);
    child.once("spawn", () => {
      record.status = "running";
      record.started_at = new Date().toISOString();
      this.persistMeta(record);
      this.broadcast(active, {
        event: "status",
        data: { status: record.status, run: record },
      });
    });
    child.stdout?.on("data", (chunk: Buffer) =>
      this.onStream(active, "stdout", chunk),
    );
    child.stderr?.on("data", (chunk: Buffer) =>
      this.onStream(active, "stderr", chunk),
    );
    // "close" (not "exit"): it fires only after stdout/stderr have been
    // fully drained, so a report frame written immediately before the child
    // exits is always processed before the verdict is latched.
    child.once("close", (code) => this.onExit(active, code));

    this.persistMeta(record);
    logger.info("console run started", {
      service: "console",
      action: "run_start",
      metadata: { run_id: id, kind: input.kind, granted, denied },
    });
    return record;
  }

  get(id: string): RunRecord | undefined {
    if (this.active?.record.id === id) return this.active.record;
    if (!isRunId(id)) return undefined;
    const metaPath = path.join(this.runsDir, id, "meta.json");
    if (!fs.existsSync(metaPath)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(metaPath, "utf8")) as RunRecord;
    } catch {
      return undefined;
    }
  }

  private readReportFile(id: string): unknown {
    if (!isRunId(id)) return undefined;
    const reportPath = path.join(this.runsDir, id, "report.json");
    if (!fs.existsSync(reportPath)) return undefined;
    try {
      const parsed = JSON.parse(fs.readFileSync(reportPath, "utf8")) as unknown;
      return typeof parsed === "object" && parsed !== null
        ? redactObject(parsed as Record<string, unknown>)
        : parsed;
    } catch {
      return undefined;
    }
  }

  list(): RunRecord[] {
    const out = new Map<string, RunRecord>();
    if (fs.existsSync(this.runsDir)) {
      for (const entry of fs.readdirSync(this.runsDir)) {
        const meta = this.get(entry);
        if (meta) out.set(meta.id, meta);
      }
    }
    if (this.active) out.set(this.active.record.id, this.active.record);
    return [...out.values()].sort((a, b) =>
      b.created_at.localeCompare(a.created_at),
    );
  }

  logsAfter(id: string, afterSeq: number): LogLine[] {
    if (this.active?.record.id === id) {
      return this.active.logs.filter((l) => l.seq > afterSeq);
    }
    if (!isRunId(id)) return [];
    const logsPath = path.join(this.runsDir, id, "logs.jsonl");
    if (!fs.existsSync(logsPath)) return [];
    return fs
      .readFileSync(logsPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as LogLine;
        } catch {
          return null;
        }
      })
      .filter((l): l is LogLine => l !== null && l.seq > afterSeq);
  }

  confirm(id: string, confirmationId: string, accept: boolean): "accepted" | "stale" | "none" {
    const active = this.active;
    if (!active || active.record.id !== id) return "none";
    const pending = active.record.pending_confirmation;
    if (!pending) return "none";
    if (pending.confirmation_id !== confirmationId) return "stale";
    this.answerConfirmation(active, accept, "operator");
    return "accepted";
  }

  cancel(id: string): boolean {
    const active = this.active;
    if (!active || active.record.id !== id) return false;
    if (!ACTIVE.includes(active.record.status)) return false;
    active.record.status = "canceled";
    this.persistMeta(active.record);
    // Windows: kill() on an already-dead / never-spawned handle throws EINVAL.
    try {
      active.child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      if (active.child.exitCode === null) {
        try {
          active.child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }, 10_000).unref();
    return true;
  }

  subscribe(id: string, fn: (frame: SseFrame) => void): (() => void) | null {
    const active = this.active;
    if (!active || active.record.id !== id) return null;
    active.subscribers.add(fn);
    return () => active.subscribers.delete(fn);
  }

  shutdown(): void {
    if (this.active && ACTIVE.includes(this.active.record.status)) {
      this.cancel(this.active.record.id);
    }
  }

  // ── internals ──────────────────────────────────────────────────────

  private onStream(
    active: ActiveRun,
    stream: "stdout" | "stderr",
    chunk: Buffer,
  ): void {
    const bufKey = stream === "stdout" ? "stdoutBuf" : "stderrBuf";
    active[bufKey] += chunk.toString();
    let newline = active[bufKey].indexOf("\n");
    while (newline >= 0) {
      const line = active[bufKey].slice(0, newline);
      active[bufKey] = active[bufKey].slice(newline + 1);
      newline = active[bufKey].indexOf("\n");
      if (!line.trim()) continue;
      const frame = stream === "stdout" ? parseFrame(line) : null;
      if (frame) {
        this.onFrame(active, frame);
      } else {
        this.appendLog(active, stream, line);
      }
    }
  }

  private onFrame(
    active: ActiveRun,
    frame: NonNullable<ReturnType<typeof parseFrame>>,
  ): void {
    const record = active.record;
    switch (frame.jaa_frame) {
      case "hello":
        record.gates = frame.gates;
        this.persistMeta(record);
        break;
      case "confirm_request": {
        const expiresAt = new Date(
          Date.now() + Math.min(frame.timeout_ms, this.confirmationTimeoutMs),
        ).toISOString();
        record.status = "awaiting_confirmation";
        record.pending_confirmation = {
          confirmation_id: frame.confirmation_id,
          summary: frame.summary,
          requested_at: new Date().toISOString(),
          expires_at: expiresAt,
        };
        this.persistMeta(record);
        // Parent-side independent auto-decline — a hung operator tab can
        // never leave a confirmation pending forever.
        active.confirmTimer = setTimeout(
          () => this.answerConfirmation(active, false, "timeout"),
          this.confirmationTimeoutMs,
        );
        this.broadcast(active, {
          event: "confirm",
          data: {
            confirmation_id: frame.confirmation_id,
            summary: frame.summary,
            expires_at: expiresAt,
          },
        });
        this.broadcast(active, {
          event: "status",
          data: { status: record.status, run: record },
        });
        break;
      }
      case "report":
        active.reportSeen = true;
        record.report = redactObject(
          (frame.report ?? {}) as Record<string, unknown>,
        );
        this.persistMeta(record);
        this.broadcast(active, {
          event: "report",
          data: { report: record.report },
        });
        break;
      case "error":
        record.error = frame.message;
        this.persistMeta(record);
        break;
    }
  }

  private answerConfirmation(
    active: ActiveRun,
    accept: boolean,
    by: "operator" | "timeout",
  ): void {
    const pending = active.record.pending_confirmation;
    if (!pending) return;
    if (active.confirmTimer) {
      clearTimeout(active.confirmTimer);
      active.confirmTimer = null;
    }
    active.record.pending_confirmation = null;
    if (ACTIVE.includes(active.record.status)) {
      active.record.status = "running";
    }
    // The child may already be gone (cancel/kill races the answer); a write
    // failure just means it never received an approval, which is the safe
    // direction.
    active.child.stdin?.write(
      serializeFrame({
        jaa_frame: "confirm_response",
        confirmation_id: pending.confirmation_id,
        accept,
      }),
      () => undefined,
    );
    logger.info("console submit confirmation answered", {
      service: "console",
      action: "confirm",
      metadata: { run_id: active.record.id, accept, by },
    });
    this.persistMeta(active.record);
    this.broadcast(active, {
      event: "status",
      data: { status: active.record.status, run: active.record },
    });
  }

  private timeOut(active: ActiveRun): void {
    if (!ACTIVE.includes(active.record.status)) return;
    active.record.status = "timed_out";
    this.persistMeta(active.record);
    active.child.kill("SIGKILL");
  }

  private onExit(active: ActiveRun, code: number | null): void {
    const record = active.record;
    clearTimeout(active.runTimer);
    if (active.confirmTimer) clearTimeout(active.confirmTimer);
    record.exit_code = code;
    record.ended_at = new Date().toISOString();
    record.pending_confirmation = null;
    if (ACTIVE.includes(record.status)) {
      // The report frame is the primary signal, but the runner also writes
      // report.json — fall back to it so a lost frame cannot turn a real
      // success into a reported failure.
      if (!active.reportSeen && code === 0) {
        const fromDisk = this.readReportFile(record.id);
        if (fromDisk !== undefined) {
          record.report = fromDisk;
          active.reportSeen = true;
        }
      }
      record.status = code === 0 && active.reportSeen ? "succeeded" : "failed";
      if (record.status === "failed" && !record.error) {
        record.error = `runner exited ${code ?? "without a code"}${
          active.reportSeen ? "" : " and no report was produced"
        }`;
      }
    }
    this.persistMeta(record);
    this.broadcast(active, {
      event: "end",
      data: { status: record.status, exit_code: code },
    });
    logger.info("console run finished", {
      service: "console",
      action: "run_end",
      metadata: { run_id: record.id, status: record.status, exit_code: code },
    });
    if (this.active === active) this.active = null;
  }

  private appendLog(
    active: ActiveRun,
    stream: "stdout" | "stderr",
    line: string,
  ): void {
    active.record.log_seq += 1;
    const entry: LogLine = { seq: active.record.log_seq, stream, line };
    active.logs.push(entry);
    if (active.logs.length > RING_LIMIT) active.logs.shift();
    fs.appendFileSync(
      path.join(this.runsDir, active.record.id, "logs.jsonl"),
      `${JSON.stringify(entry)}\n`,
    );
    this.broadcast(active, { event: "log", data: entry });
  }

  private broadcast(active: ActiveRun, frame: SseFrame): void {
    for (const fn of active.subscribers) {
      try {
        fn(frame);
      } catch {
        active.subscribers.delete(fn);
      }
    }
  }

  private persistMeta(record: RunRecord): void {
    const dir = path.join(this.runsDir, record.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify(record, null, 2),
    );
  }
}
