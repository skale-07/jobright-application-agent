import { Link } from "react-router-dom";
import { apiGet } from "../api/client";
import type { Summary } from "../api/types";
import { usePoll } from "../hooks/usePoll";
import { StateBadge } from "../components/StateBadge";

const STAGE_MEANING: Record<number, string> = {
  1: "inspection only — fill disabled",
  2: "fill enabled, submit disabled",
  3: "submit enabled, every submission confirmed by a human",
  4: "unattended submissions capped",
  5: "unattended",
};

export function OverviewPage(): JSX.Element {
  const { data, error, loading } = usePoll<Summary>(
    () => apiGet<Summary>("/api/summary"),
    5000,
  );

  if (loading && !data) return <p className="faint">Loading…</p>;
  if (error) return <div className="banner danger">{error}</div>;
  if (!data) return <p className="faint">No data.</p>;

  const byState = [...data.applications_by_state].sort((a, b) => b.n - a.n);
  const total = byState.reduce((sum, s) => sum + s.n, 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <div className="sub mono">{data.database}</div>
        </div>
      </div>

      <div className="stat-row">
        <div className="stat">
          <div className="label">Applications</div>
          <div className="value">{total}</div>
          <div className="hint">{byState.length} distinct states</div>
        </div>
        <div className="stat">
          <div className="label">Open reviews</div>
          <div className="value" style={{ color: data.open_review_items > 0 ? "var(--warn)" : undefined }}>
            {data.open_review_items}
          </div>
          <div className="hint">
            <Link to="/review">go to queue</Link>
          </div>
        </div>
        <div className="stat">
          <div className="label">Rollout stage</div>
          <div className="value">{data.rollout_stage}</div>
          <div className="hint">{STAGE_MEANING[data.rollout_stage] ?? ""}</div>
        </div>
        <div className="stat">
          <div className="label">Mode</div>
          <div className="value" style={{ fontSize: "1.1rem" }}>
            {data.dry_run ? "DRY RUN" : "LIVE"}
          </div>
          <div className="hint">
            fill {data.form_fill_enabled ? "on" : "off"} · submit{" "}
            {data.submit_enabled ? "on" : "off"}
          </div>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <h2>Applications by state</h2>
          {byState.length === 0 ? (
            <p className="faint">Nothing enqueued yet.</p>
          ) : (
            <table>
              <tbody>
                {byState.map((s) => (
                  <tr key={s.state}>
                    <td>
                      <Link to={`/applications?state=${s.state}`}>
                        <StateBadge value={s.state} />
                      </Link>
                    </td>
                    <td className="mono" style={{ textAlign: "right", width: "4rem" }}>
                      {s.n}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <h2>Session readiness</h2>
          <table>
            <tbody>
              {data.auth.map((a) => (
                <tr key={a.service}>
                  <td className="mono">{a.service}</td>
                  <td>
                    <span className={`badge ${a.ready ? "ok" : "warn"}`}>
                      {a.ready ? "ready" : "not ready"}
                    </span>
                  </td>
                  <td className="muted">{a.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
