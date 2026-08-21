import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiPost } from "../api/client";
import { useRunEvents } from "../hooks/useRunEvents";
import { StateBadge } from "../components/StateBadge";
import { LogViewer } from "../components/LogViewer";
import { JsonView } from "../components/JsonView";
import { ConfirmSubmitModal } from "../components/ConfirmSubmitModal";
import { Icon } from "../components/Icon";

export function RunDetailPage(): JSX.Element {
  const { id = "" } = useParams();
  const { run, logs, transport, error } = useRunEvents(id);
  const [actionError, setActionError] = useState<string | null>(null);

  const answer = async (accept: boolean): Promise<void> => {
    if (!run?.pending_confirmation) return;
    try {
      await apiPost(`/api/runs/${id}/confirm`, {
        confirmation_id: run.pending_confirmation.confirmation_id,
        accept,
      });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const cancel = async (): Promise<void> => {
    try {
      await apiPost(`/api/runs/${id}/cancel`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const isActive =
    run != null &&
    ["pending", "running", "awaiting_confirmation"].includes(run.status);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            {run?.kind ?? "run"} <span className="muted mono">{id.slice(4, 12)}</span>
          </h1>
          <div className="sub">
            <Link to="/runs">
              <Icon name="arrow-left" size={13} /> all runs
            </Link>
          </div>
        </div>
        <div style={{ display: "flex", gap: "0.6rem", alignItems: "center" }}>
          <span className="badge neutral">{transport}</span>
          <StateBadge value={run?.status} kind="run" />
          {isActive ? (
            <button className="danger" onClick={cancel}>
              Cancel run
            </button>
          ) : null}
        </div>
      </div>

      {error ? <div className="banner warn">{error}</div> : null}
      {actionError ? <div className="banner danger">{actionError}</div> : null}
      {run?.error ? <div className="banner danger">{run.error}</div> : null}

      {run ? (
        <div className="card">
          <h2>Run</h2>
          <dl className="kv">
            <dt>Granted</dt>
            <dd>{run.granted_flags.length > 0 ? run.granted_flags.join(", ") : "none"}</dd>
            <dt>Denied</dt>
            <dd>{run.denied_flags.length > 0 ? run.denied_flags.join(", ") : "none"}</dd>
            <dt>Started</dt>
            <dd>{run.started_at ?? "—"}</dd>
            <dt>Ended</dt>
            <dd>{run.ended_at ?? "—"}</dd>
            <dt>Exit code</dt>
            <dd>{run.exit_code ?? "—"}</dd>
          </dl>
          {run.gates ? (
            <div style={{ marginTop: "0.75rem" }}>
              <JsonView value={run.gates} label="gates the child actually received" />
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="card">
        <h2>Output</h2>
        <LogViewer logs={logs} />
      </div>

      {run?.report != null ? (
        <div className="card">
          <h2>Report</h2>
          <JsonView value={run.report} label="run report" open />
        </div>
      ) : null}

      {run?.pending_confirmation ? (
        <ConfirmSubmitModal
          summary={run.pending_confirmation.summary}
          expiresAt={run.pending_confirmation.expires_at}
          disabled={transport === "connecting"}
          onAnswer={(accept) => void answer(accept)}
        />
      ) : null}
    </>
  );
}
