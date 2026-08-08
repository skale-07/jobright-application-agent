import { useEffect, useRef, useState } from "react";
import { apiGet } from "../api/client";
import type { LogLine, RunRecord } from "../api/types";

export type RunStream = {
  run: RunRecord | null;
  logs: LogLine[];
  transport: "sse" | "poll" | "connecting";
  error: string | null;
};

const MAX_LINES = 3000;

/**
 * Live run view: SSE first, falling back to ?after_seq polling after two
 * failed connections (some proxies and older setups drop event streams).
 * Either way the server replays from seq 0, so a late-joining tab is
 * complete.
 */
export function useRunEvents(runId: string | undefined): RunStream {
  const [run, setRun] = useState<RunRecord | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [transport, setTransport] = useState<RunStream["transport"]>("connecting");
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!runId) return;
    let alive = true;
    let failures = 0;
    let source: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    seqRef.current = 0;
    setRun(null);
    setLogs([]);
    setTransport("connecting");
    setError(null);

    const pushLog = (line: LogLine): void => {
      seqRef.current = Math.max(seqRef.current, line.seq);
      setLogs((prev) => {
        const next = [...prev, line];
        return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
      });
    };

    const startPolling = (): void => {
      if (!alive || pollTimer) return;
      setTransport("poll");
      const tick = async (): Promise<void> => {
        try {
          const data = await apiGet<{ run: RunRecord; logs: LogLine[] }>(
            `/api/runs/${runId}?after_seq=${seqRef.current}`,
          );
          if (!alive) return;
          setRun(data.run);
          for (const line of data.logs) pushLog(line);
          setError(null);
        } catch (err) {
          if (alive) setError(err instanceof Error ? err.message : String(err));
        }
      };
      void tick();
      pollTimer = setInterval(() => {
        if (document.visibilityState === "visible") void tick();
      }, 2000);
    };

    const connect = (): void => {
      if (!alive) return;
      source = new EventSource(`/api/runs/${runId}/events`);
      source.addEventListener("open", () => {
        failures = 0;
        setTransport("sse");
        setError(null);
      });
      source.addEventListener("status", (e) => {
        const data = JSON.parse((e as MessageEvent<string>).data) as { run: RunRecord };
        setRun(data.run);
      });
      source.addEventListener("log", (e) => {
        pushLog(JSON.parse((e as MessageEvent<string>).data) as LogLine);
      });
      source.addEventListener("confirm", () => {
        // Status frames carry the pending confirmation; force a refresh so
        // the modal opens even if the status frame raced ahead.
        void apiGet<{ run: RunRecord }>(`/api/runs/${runId}?after_seq=${seqRef.current}`)
          .then((d) => alive && setRun(d.run))
          .catch(() => undefined);
      });
      source.addEventListener("report", () => {
        void apiGet<{ run: RunRecord }>(`/api/runs/${runId}?after_seq=${seqRef.current}`)
          .then((d) => alive && setRun(d.run))
          .catch(() => undefined);
      });
      source.addEventListener("end", () => {
        source?.close();
        source = null;
        void apiGet<{ run: RunRecord }>(`/api/runs/${runId}?after_seq=${seqRef.current}`)
          .then((d) => alive && setRun(d.run))
          .catch(() => undefined);
      });
      source.addEventListener("error", () => {
        source?.close();
        source = null;
        failures += 1;
        if (!alive) return;
        if (failures >= 2) startPolling();
        else setTimeout(connect, 1000);
      });
    };

    connect();
    return () => {
      alive = false;
      source?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [runId]);

  return { run, logs, transport, error };
}
