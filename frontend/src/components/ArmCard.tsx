import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiPost } from "../api/client";
import type { ArmStatus } from "../api/types";
import { formatCountdown } from "../hooks/useArmStatus";
import { AUTOMATION_RUN_BODY } from "../lib/automationRun";

/**
 * Arm / disarm the L3 unattended session. Arming here does NOT itself make
 * any submit unattended — a submit only bypasses confirmation when it runs
 * inside an `automation` worker launched against a live arm. The card is
 * deliberately loud: while armed, the whole app also shows a global banner.
 */
export function ArmCard({
  status,
  onChanged,
}: {
  status: ArmStatus | null;
  onChanged: () => void;
}): JSX.Element {
  const navigate = useNavigate();
  const [duration, setDuration] = useState("120");
  const [maxSubmits, setMaxSubmits] = useState("10");
  const [maxApps, setMaxApps] = useState("25");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const arm = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/automation/arm", {
        duration_minutes: Number(duration) || 120,
        max_submits: Number(maxSubmits) || 10,
        max_apps: Number(maxApps) || 25,
      });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /** Launch the automation worker against the live arm. */
  const startWorker = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<{ run_id: string }>("/api/runs", AUTOMATION_RUN_BODY);
      navigate(`/runs/${res.run_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /** One action: arm with the entered bounds, then launch the worker. */
  const startSession = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/automation/arm", {
        duration_minutes: Number(duration) || 120,
        max_submits: Number(maxSubmits) || 10,
        max_apps: Number(maxApps) || 25,
      });
      onChanged();
      const res = await apiPost<{ run_id: string }>("/api/runs", AUTOMATION_RUN_BODY);
      navigate(`/runs/${res.run_id}`);
    } catch (err) {
      // A failed launch leaves the session ARMED — the card shows that and
      // the operator can retry the worker or disarm.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const disarm = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/automation/disarm");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const armed = status?.armed === true;

  return (
    <div className="card" style={armed ? { borderColor: "var(--danger)" } : undefined}>
      <h2>Unattended session</h2>
      {error ? <div className="banner danger">{error}</div> : null}
      {status?.agent_phase ? (
        <p
          className="mono"
          style={{
            fontSize: "11.5px",
            marginTop: 0,
            color: status.agent_phase.available ? "var(--ok)" : "var(--warn)",
          }}
        >
          nav agent: {status.agent_phase.available ? "available" : "unavailable"} —{" "}
          {status.agent_phase.reason}
        </p>
      ) : null}

      {armed && status ? (
        <>
          <div className="stat-row" style={{ marginBottom: "0.5rem" }}>
            <div className="stat">
              <div className="label">time left</div>
              <div className="value">{formatCountdown(status.seconds_remaining)}</div>
            </div>
            <div className="stat">
              <div className="label">submits</div>
              <div className="value">
                {status.submits_used}
                <span className="faint"> / {status.max_submits}</span>
              </div>
            </div>
            <div className="stat">
              <div className="label">apps</div>
              <div className="value">
                {status.apps_started}
                <span className="faint"> / {status.max_apps}</span>
              </div>
            </div>
            {status.last_error_code ? (
              <div className="stat">
                <div className="label">last error</div>
                <div className="value mono" style={{ fontSize: "1rem", color: "var(--warn)" }}>
                  {status.last_error_code}
                </div>
              </div>
            ) : null}
          </div>
          <p className="muted flush-top">
            Submits made by the automation worker during this window skip the
            per-app confirmation. Disarm — or a console restart — stops that
            immediately.
          </p>
          <div className="toolbar flush-bottom">
            <button className="primary" onClick={() => void startWorker()} disabled={busy}>
              Start automation worker
            </button>
            <button className="danger" onClick={() => void disarm()} disabled={busy}>
              Disarm now
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="muted flush-top">
            While armed, the automation worker may click Submit without asking
            per application — bounded by the duration and caps below. Every
            other gate still runs; walls still park; mail is never sent.
          </p>
          <div className="stat-row" style={{ marginBottom: "0.75rem" }}>
            <label className="field">
              Duration (min, 15–240)
              <input
                type="number"
                min={15}
                max={240}
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
              />
            </label>
            <label className="field">
              Max submits
              <input
                type="number"
                min={1}
                value={maxSubmits}
                onChange={(e) => setMaxSubmits(e.target.value)}
              />
            </label>
            <label className="field">
              Max apps
              <input
                type="number"
                min={1}
                value={maxApps}
                onChange={(e) => setMaxApps(e.target.value)}
              />
            </label>
          </div>
          <div className="toolbar flush-bottom">
            <button className="primary" onClick={() => void startSession()} disabled={busy}>
              Start L3 session
            </button>
            <button onClick={() => void arm()} disabled={busy}>
              Arm only
            </button>
          </div>
          <p className="faint flush-bottom">
            Start L3 session = arm with these bounds, then launch the
            automation worker. Arm only leaves launching to you.
          </p>
        </>
      )}
    </div>
  );
}
