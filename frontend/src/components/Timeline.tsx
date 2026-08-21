import type { TimelineEntry } from "../api/types";
import { StateBadge } from "./StateBadge";
import { EmptyState } from "./EmptyState";

export function Timeline({ entries }: { entries: TimelineEntry[] }): JSX.Element {
  if (entries.length === 0) {
    return (
      <EmptyState
        icon="clock"
        title="No steps yet"
        body="Every state change this application makes will be recorded here, with its reason."
      />
    );
  }
  return (
    <ul className="timeline">
      {entries.map((e, i) => (
        <li key={`${e.timestamp}-${i}`}>
          <div className="t-head">
            <StateBadge value={e.next_state} />
            <span className="t-when">{new Date(e.timestamp).toLocaleString()}</span>
            {e.previous_state ? (
              <span className="faint mono">from {e.previous_state}</span>
            ) : null}
            {e.attempt != null ? (
              <span className="faint mono">attempt {e.attempt}</span>
            ) : null}
          </div>
          {e.reason ? <div className="t-reason">{e.reason}</div> : null}
          {e.warnings.length > 0 ? (
            <div className="t-reason" style={{ color: "var(--warn)" }}>
              {e.warnings.join(" · ")}
            </div>
          ) : null}
          {e.artifacts.length > 0 ? (
            <div className="t-artifacts">
              {e.artifacts.map((a) => (
                <a
                  key={a}
                  className="mono"
                  href={`/api/artifacts?path=${encodeURIComponent(a)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {a.split("/").slice(-2).join("/")}
                </a>
              ))}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
