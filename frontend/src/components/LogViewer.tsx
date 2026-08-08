import { useEffect, useRef, useState } from "react";
import type { LogLine } from "../api/types";

type Parsed = { level?: string; message?: string; service?: string; action?: string };

function parse(line: string): Parsed | null {
  if (!line.trim().startsWith("{")) return null;
  try {
    return JSON.parse(line) as Parsed;
  } catch {
    return null;
  }
}

const LEVEL_COLOR: Record<string, string> = {
  error: "var(--danger)",
  warn: "var(--warn)",
  info: "var(--text)",
  debug: "var(--text-faint)",
};

export function LogViewer({ logs }: { logs: LogLine[] }): JSX.Element {
  const [follow, setFollow] = useState(true);
  const paneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (follow && paneRef.current) {
      paneRef.current.scrollTop = paneRef.current.scrollHeight;
    }
  }, [logs, follow]);

  return (
    <>
      <div className="toolbar" style={{ marginBottom: "0.5rem" }}>
        <label style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => setFollow(e.target.checked)}
          />
          <span className="muted">follow</span>
        </label>
        <span className="faint mono">{logs.length} lines</span>
      </div>
      <div className="log-pane mono" ref={paneRef}>
        {logs.length === 0 ? (
          <span className="faint">waiting for output…</span>
        ) : (
          logs.map((l) => {
            const parsed = parse(l.line);
            return (
              <div key={l.seq} style={{ whiteSpace: "pre-wrap" }}>
                {parsed?.message ? (
                  <>
                    <span className="faint">
                      {parsed.service ?? "-"}
                      {parsed.action ? `/${parsed.action}` : ""}{" "}
                    </span>
                    <span style={{ color: LEVEL_COLOR[parsed.level ?? "info"] }}>
                      {parsed.message}
                    </span>
                  </>
                ) : (
                  <span
                    style={{
                      color: l.stream === "stderr" ? "var(--warn)" : undefined,
                    }}
                  >
                    {l.line}
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
