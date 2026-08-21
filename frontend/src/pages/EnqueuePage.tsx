import { useState } from "react";
import { apiPost } from "../api/client";
import { JsonView } from "../components/JsonView";

export function EnqueuePage(): JSX.Element {
  const [refs, setRefs] = useState("");
  const [employerUrl, setEmployerUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<unknown>(null);
  const [retried, setRetried] = useState<unknown>(null);

  const list = refs
    .split("\n")
    .map((r) => r.trim())
    .filter(Boolean);

  const enqueue = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      setReport(
        await apiPost("/api/enqueue", {
          refs: list,
          ...(employerUrl.trim() ? { employer_url: employerUrl.trim() } : {}),
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const retry = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setRetried(await apiPost("/api/retry"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>Enqueue</h1>
        <div className="sub">JobRight job IDs or URLs, one per line</div>
      </div>

      {error ? <div className="banner danger">{error}</div> : null}

      <div className="card">
        <h2>Add jobs</h2>
        <label className="field">
          Job references
          <textarea
            rows={6}
            value={refs}
            onChange={(e) => setRefs(e.target.value)}
            placeholder={"https://jobright.ai/jobs/info/…\n…"}
          />
        </label>
        <label className="field stack-sm">
          Employer application URL (optional — single reference only)
          <input
            value={employerUrl}
            onChange={(e) => setEmployerUrl(e.target.value)}
            placeholder="https://boards.greenhouse.io/…"
            disabled={list.length > 1}
          />
        </label>
        <div className="toolbar stack flush-bottom">
          <button
            className="primary"
            onClick={() => void enqueue()}
            disabled={busy || list.length === 0}
          >
            Enqueue {list.length > 0 ? `${list.length} job(s)` : ""}
          </button>
        </div>
        {report ? (
          <div className="stack">
            <JsonView value={report} label="enqueue report" open />
          </div>
        ) : null}
      </div>

      <div className="card">
        <h2>Retry failed applications</h2>
        <p className="muted flush-top">
          Requeues everything in FAILED_RETRYABLE that is under the attempt cap,
          and finalizes the rest.
        </p>
        <button onClick={() => void retry()} disabled={busy}>
          Run retry sweep
        </button>
        {retried ? (
          <div className="stack">
            <JsonView value={retried} label="retry result" open />
          </div>
        ) : null}
      </div>
    </>
  );
}
