import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiGet, apiPost } from "../api/client";
import type { FlagsView, RunRecord } from "../api/types";
import { usePoll } from "../hooks/usePoll";
import { StateBadge } from "../components/StateBadge";
import { FlagPicker } from "../components/FlagPicker";

type Kind =
  | "pipeline"
  | "nav"
  | "submit"
  | "discover"
  | "automation"
  | "contacts"
  | "email"
  | "gmail_draft";

const KIND_HELP: Record<Kind, string> = {
  pipeline: "Advance applications through the state machine.",
  nav: "Resolve the employer application URL from the JobRight job page.",
  submit: "Fill, verify, and submit one application (you confirm the click).",
  discover: "Pull jobs from the JobRight feed and enqueue them (needs a JobRight session).",
  automation:
    "L3 worker: process the queue unattended while the arm session is live (arm on Overview first).",
  contacts:
    "Find insider emails on the JobRight job page (school + beyond panels; spends contact credits).",
  email: "Write outreach emails for this application's contacts (LLM; drafts only).",
  gmail_draft: "Save the written emails as Gmail drafts (never sends).",
};

export function RunsPage(): JSX.Element {
  const navigate = useNavigate();
  const runs = usePoll<RunRecord[]>(() => apiGet<RunRecord[]>("/api/runs"), 3000);
  const flags = usePoll<FlagsView>(() => apiGet<FlagsView>("/api/flags"), 30000);

  const [kind, setKind] = useState<Kind>("pipeline");
  const [applicationId, setApplicationId] = useState("");
  const [maxApplications, setMaxApplications] = useState("1");
  const [maxJobs, setMaxJobs] = useState("10");
  const [headed, setHeaded] = useState(true);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [liveMode, setLiveMode] = useState(false);
  const [submitOptIn, setSubmitOptIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const active = (runs.data ?? []).find((r) =>
    ["pending", "running", "awaiting_confirmation"].includes(r.status),
  );

  const launch = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const params: Record<string, unknown> = { headed };
      if (applicationId.trim()) params["application_id"] = applicationId.trim();
      if (kind === "pipeline") {
        params["max_applications"] = Number(maxApplications) || 1;
        if (submitOptIn) params["submit"] = true;
      }
      if (kind === "discover") params["max_jobs"] = Number(maxJobs) || 10;
      const res = await apiPost<{ run_id: string }>("/api/runs", {
        kind,
        params,
        flags: selected,
        live_mode: liveMode,
      });
      navigate(`/runs/${res.run_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>Runs</h1>
        <div className="sub">one run at a time</div>
      </div>

      {error ? <div className="banner danger">{error}</div> : null}
      {active ? (
        <div className="banner warn">
          <Link to={`/runs/${active.id}`}>
            A {active.kind} run is {active.status.replace("_", " ")} — open it
          </Link>
        </div>
      ) : null}

      <div className="card">
        <h2>Launch a run</h2>
        <div className="grid-2">
          <div style={{ display: "grid", gap: "0.75rem" }}>
            <label className="field">
              Kind
              <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                <option value="pipeline">pipeline</option>
                <option value="nav">nav — resolve employer URL</option>
                <option value="submit">submit</option>
                <option value="discover">discover — pull + enqueue jobs</option>
                <option value="automation">automation — L3 unattended worker</option>
                <option value="contacts">contacts — find insider emails</option>
                <option value="email">email — write outreach emails</option>
                <option value="gmail_draft">gmail_draft — save Gmail drafts</option>
              </select>
            </label>
            <p className="faint" style={{ margin: 0 }}>
              {KIND_HELP[kind]}
            </p>
            {kind === "discover" ? (
              <label className="field">
                Max jobs
                <input
                  type="number"
                  min={1}
                  value={maxJobs}
                  onChange={(e) => setMaxJobs(e.target.value)}
                />
              </label>
            ) : kind === "automation" ? (
              <p className="faint" style={{ margin: 0 }}>
                Scope comes from the armed session (caps, discovery cadence) —
                nothing to configure here.
              </p>
            ) : (
              <label className="field">
                Application ID {kind === "pipeline" ? "(optional)" : "(required)"}
                <input
                  value={applicationId}
                  onChange={(e) => setApplicationId(e.target.value)}
                  placeholder="uuid"
                />
              </label>
            )}
            {kind === "pipeline" ? (
              <>
                <label className="field">
                  Max applications
                  <input
                    type="number"
                    min={1}
                    value={maxApplications}
                    onChange={(e) => setMaxApplications(e.target.value)}
                  />
                </label>
                <label style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                  <input
                    type="checkbox"
                    checked={submitOptIn}
                    onChange={(e) => setSubmitOptIn(e.target.checked)}
                  />
                  <span>
                    Delegate READY_TO_SUBMIT to submit{" "}
                    <span className="faint">(you still confirm each click)</span>
                  </span>
                </label>
              </>
            ) : null}
            <label style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <input
                type="checkbox"
                checked={headed}
                onChange={(e) => setHeaded(e.target.checked)}
              />
              <span>
                Headed browser{" "}
                <span className="faint">
                  (default on — uncheck for headless)
                </span>
              </span>
            </label>
          </div>

          <div>
            <h2>Capabilities for this run</h2>
            {flags.data ? (
              <FlagPicker
                flags={flags.data}
                selected={selected}
                liveMode={liveMode}
                onToggleFlag={(key, value) =>
                  setSelected((prev) => ({ ...prev, [key]: value }))
                }
                onToggleLive={setLiveMode}
              />
            ) : (
              <p className="faint">Loading flags…</p>
            )}
          </div>
        </div>

        <div className="toolbar" style={{ marginTop: "1rem", marginBottom: 0 }}>
          <button className="primary" onClick={launch} disabled={busy || Boolean(active)}>
            {busy ? "Starting…" : "Launch run"}
          </button>
          {active ? (
            <span className="faint">finish or cancel the active run first</span>
          ) : null}
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Started</th>
              <th>Kind</th>
              <th>Status</th>
              <th>Granted</th>
              <th className="mono">Run</th>
            </tr>
          </thead>
          <tbody>
            {(runs.data ?? []).map((r) => (
              <tr key={r.id}>
                <td className="mono faint nowrap">
                  {new Date(r.created_at).toLocaleString()}
                </td>
                <td className="mono">{r.kind}</td>
                <td>
                  <StateBadge value={r.status} kind="run" />
                </td>
                <td className="mono faint">
                  {r.granted_flags.length > 0 ? r.granted_flags.join(", ") : "none"}
                </td>
                <td>
                  <Link className="mono" to={`/runs/${r.id}`}>
                    {r.id.slice(4, 12)}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {(runs.data?.length ?? 0) === 0 ? (
          <div className="empty">No runs yet.</div>
        ) : null}
      </div>
    </>
  );
}
