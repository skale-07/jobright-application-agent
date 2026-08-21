import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet, apiPost } from "../api/client";
import type { ApplicationDetail } from "../api/types";
import { usePoll } from "../hooks/usePoll";
import { StateBadge } from "../components/StateBadge";
import { StatusChip } from "../components/StatusChip";
import { Timeline } from "../components/Timeline";
import { JsonView } from "../components/JsonView";
import { APP_STATUS, deriveStatus } from "../lib/appStatus";
import { OutreachCard } from "../components/OutreachCard";
import { SkeletonCard } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import {
  artifactLabel,
  artifactUrl,
  FillEvidence,
  ScreenshotEvidence,
} from "../components/Evidence";

function str(record: Record<string, unknown>, key: string): string | null {
  const v = record[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function ApplicationDetailPage(): JSX.Element {
  const { id = "" } = useParams();
  const { data, error, loading, refresh } = usePoll<ApplicationDetail>(
    () => apiGet<ApplicationDetail>(`/api/applications/${id}`),
    5000,
    [id],
  );
  const [toggleBusy, setToggleBusy] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);

  if (loading && !data)
    return (
      <>
        <SkeletonCard lines={5} />
        <SkeletonCard lines={3} />
      </>
    );
  if (error) return <div className="banner danger">{error}</div>;
  if (!data) return <p className="faint">Not found.</p>;

  const state = String(data.application["state"] ?? "");
  const employerUrl = str(data.job, "employer_application_url");
  const excluded = data.application["automation_excluded"] === true;
  const hasOpenReview = data.review_items.some((r) =>
    ["OPEN", "IN_PROGRESS"].includes(r.status),
  );
  const status = deriveStatus(state, hasOpenReview);
  const receipts = data.submissions.filter(
    (s) => typeof s["screenshot_path"] === "string" && s["screenshot_path"],
  );
  const latestFillReport = data.fill_runs
    .map((f) => f["report_artifact_relpath"])
    .find((r): r is string => typeof r === "string" && r.length > 0);

  const toggleAutomation = async (): Promise<void> => {
    setToggleBusy(true);
    setToggleError(null);
    try {
      await apiPost(`/api/applications/${id}/automation`, { excluded: !excluded });
      refresh();
    } catch (err) {
      setToggleError(err instanceof Error ? err.message : String(err));
    } finally {
      setToggleBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            {str(data.job, "company") ?? "Unknown company"}{" "}
            <span className="muted" style={{ fontWeight: 400 }}>
              — {str(data.job, "role") ?? "?"}
            </span>
          </h1>
          {/* The head speaks the operator's language; the machine state
              lives in the technical block below with the rest of the
              debugging surface. */}
          <div className="sub">{APP_STATUS[status].hint}</div>
        </div>
        <div className="row">
          <StatusChip status={status} />
          <button className="ghost" onClick={() => void toggleAutomation()} disabled={toggleBusy}>
            {excluded ? "include in automation" : "exclude from automation"}
          </button>
        </div>
      </div>
      {toggleError ? <div className="banner danger">{toggleError}</div> : null}
      {excluded ? (
        <div className="banner warn">
          Excluded from L3 automation — the unattended worker will skip this
          application until it is included again.
        </div>
      ) : null}

      {/* Evidence first. What this application actually did lives on disk
          as screenshots and per-field reports; the page leads with those
          instead of ending in a list of file paths. */}
      {receipts.length > 0 || latestFillReport ? (
        <div className="card">
          <h2>Evidence</h2>
          {receipts.length > 0 ? (
            <div className="evidence-grid">
              {receipts.map((r) => (
                <ScreenshotEvidence
                  key={String(r["id"])}
                  path={String(r["screenshot_path"])}
                  caption={`Attempt ${String(r["submission_attempt_number"])} · ${String(r["status"])}`}
                  when={
                    r["submitted_at"]
                      ? new Date(String(r["submitted_at"])).toLocaleString()
                      : null
                  }
                />
              ))}
            </div>
          ) : null}
          {latestFillReport ? (
            <>
              <h3 style={{ margin: "1rem 0 0.5rem" }}>Last fill, field by field</h3>
              <FillEvidence relpath={latestFillReport} />
            </>
          ) : null}
        </div>
      ) : null}

      <div className="grid-2">
        <div className="card">
          <h2>Job</h2>
          <dl className="kv">
            <dt>Employer URL</dt>
            <dd>
              {employerUrl ? (
                <a href={employerUrl} target="_blank" rel="noreferrer">
                  {employerUrl}
                </a>
              ) : (
                <span className="faint">not resolved yet</span>
              )}
            </dd>
            <dt>ATS</dt>
            <dd>{str(data.job, "employer_application_ats") ?? "—"}</dd>
            <dt>Location</dt>
            <dd>{str(data.job, "location") ?? "—"}</dd>
            <dt>Nav session</dt>
            <dd>{str(data.job, "nav_session") ?? "—"}</dd>
            <dt>Route</dt>
            <dd>{String(data.application["route"] ?? "—")}</dd>
            <dt>Attempt</dt>
            <dd>{String(data.application["attempt"] ?? 0)}</dd>
            <dt>Machine state</dt>
            <dd>
              <StateBadge value={state} />
            </dd>
            <dt>Application ID</dt>
            <dd className="mono faint">{id}</dd>
          </dl>
          {state === "READY_TO_SUBMIT" ? (
            <div className="banner ok stack">
              Ready to submit. Launch a submit run from{" "}
              <Link to="/runs">Runs</Link>, or from a terminal:
              <pre className="json mono" style={{ marginTop: "0.5rem" }}>
                npm run submit -- --application {id}
              </pre>
            </div>
          ) : null}
        </div>

        <div className="card">
          <h2>Materials & submissions</h2>
          {data.materials.length === 0 ? (
            <p className="faint">No resume registered.</p>
          ) : (
            <table>
              <tbody>
                {data.materials.map((m) => (
                  <tr key={String(m["id"])}>
                    <td className="mono">{String(m["kind"])}</td>
                    <td className="mono faint">
                      {String(m["sha256"] ?? "").slice(0, 12)}…
                    </td>
                    <td className="mono">{String(m["size_bytes"])} B</td>
                    <td>
                      <span className={`badge ${m["verified"] ? "ok" : "warn"}`}>
                        {m["verified"] ? "verified" : "unverified"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {data.submissions.length > 0 ? (
            <table className="stack-sm">
              <thead>
                <tr>
                  <th>Attempt</th>
                  <th>Status</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {data.submissions.map((s) => (
                  <tr key={String(s["id"])}>
                    <td className="mono">{String(s["submission_attempt_number"])}</td>
                    <td>
                      <span
                        className={`badge ${
                          s["status"] === "VERIFIED"
                            ? "ok"
                            : s["status"] === "FAILED"
                              ? "danger"
                              : "warn"
                        }`}
                      >
                        {String(s["status"])}
                      </span>
                    </td>
                    <td className="mono faint">
                      {s["submitted_at"] ? String(s["submitted_at"]) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      </div>

      {data.review_items.length > 0 ? (
        <div className="card">
          <h2>Review items</h2>
          <table>
            <thead>
              <tr>
                <th>Kind</th>
                <th>Status</th>
                <th>Title</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {data.review_items.map((r) => (
                <tr key={r.id}>
                  <td>
                    <StateBadge value={r.kind} kind="review" />
                  </td>
                  <td>
                    <StateBadge value={r.status} kind="review" />
                  </td>
                  <td>{r.title}</td>
                  <td className="mono faint nowrap">
                    {new Date(r.created_at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <OutreachCard applicationId={id} detail={data} />

      <div className="card">
        <h2>Timeline</h2>
        <Timeline entries={data.timeline} />
      </div>

      {data.artifact_links.length > 0 ? (
        <div className="card">
          <h2>Artifacts</h2>
          <div className="t-artifacts">
            {data.artifact_links.map((a) => (
              <a key={a} href={artifactUrl(a)} target="_blank" rel="noreferrer" title={a}>
                {artifactLabel(a)}
              </a>
            ))}
          </div>
        </div>
      ) : null}

      <div className="card">
        <h2>Fill runs</h2>
        {data.fill_runs.length === 0 ? (
          <EmptyState
            icon="file"
            title="No fill runs yet"
            body="Each attempt to fill this form will be recorded here with what verified and what did not."
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>ATS</th>
                <th>Mode</th>
                <th>Verify</th>
                <th>Level</th>
              </tr>
            </thead>
            <tbody>
              {data.fill_runs.map((f) => (
                <tr key={String(f["id"])}>
                  <td className="mono faint nowrap">{String(f["created_at"])}</td>
                  <td className="mono">{String(f["ats"])}</td>
                  <td className="mono">{String(f["mode"])}</td>
                  <td>
                    <span className={`badge ${f["verify_passed"] ? "ok" : "warn"}`}>
                      {f["verify_passed"] ? "passed" : "failed"}
                    </span>
                  </td>
                  <td className="mono faint">{String(f["validation_level"])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <JsonView value={data} label="full detail payload" />
      </div>
    </>
  );
}
