import { useEffect, useState } from "react";
import type { SubmitConfirmationSummary } from "../api/types";

/**
 * The web transport for the submit confirmation. Shows exactly what the
 * terminal prompt showed, requires typing the company name to arm the
 * button, and counts down to the server-side expiry — which declines on
 * its own if nobody answers, so an abandoned tab can never submit.
 */
export function ConfirmSubmitModal({
  summary,
  expiresAt,
  disabled,
  onAnswer,
}: {
  summary: SubmitConfirmationSummary;
  expiresAt: string;
  disabled?: boolean;
  onAnswer: (accept: boolean) => void;
}): JSX.Element {
  const [typed, setTyped] = useState("");
  const [remaining, setRemaining] = useState(() => secondsLeft(expiresAt));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setRemaining(secondsLeft(expiresAt)), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  const expected = (summary.company ?? "").trim();
  const armed =
    !busy &&
    !disabled &&
    remaining > 0 &&
    expected.length > 0 &&
    typed.trim().toLowerCase() === expected.toLowerCase();

  const answer = (accept: boolean): void => {
    setBusy(true);
    onAnswer(accept);
  };

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>Submit this application?</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          This is the single irreversible click. Everything below is what the
          run is about to send.
        </p>

        <dl className="kv">
          <dt>Company</dt>
          <dd>{summary.company ?? "?"}</dd>
          <dt>Role</dt>
          <dd>{summary.role ?? "?"}</dd>
          <dt>URL</dt>
          <dd>{summary.url}</dd>
          <dt>Attempt</dt>
          <dd>{summary.attempt}</dd>
          <dt>Resume</dt>
          <dd>
            sha256 {summary.resume_sha256.slice(0, 16)}… ({summary.resume_size_bytes} bytes)
          </dd>
          <dt>Plan</dt>
          <dd>
            {summary.plan.fillable_count} fill · {summary.plan.skipped_count} skip ·{" "}
            {summary.plan.review_required_count} review
          </dd>
        </dl>

        {disabled ? (
          <div className="banner warn" style={{ marginTop: "1rem" }}>
            Connection to the run was lost. It will decline on its own when the
            timer runs out.
          </div>
        ) : null}

        <label className="field" style={{ marginTop: "1rem" }}>
          Type <strong>{expected || "the company name"}</strong> to enable Submit
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={expected}
            autoFocus
          />
        </label>

        <div className="modal-actions">
          <span className={remaining < 60 ? "badge danger" : "badge neutral"}>
            {remaining > 0 ? `${formatRemaining(remaining)} left` : "expired"}
          </span>
          <div style={{ flex: 1 }} />
          <button onClick={() => answer(false)} disabled={busy}>
            Decline
          </button>
          <button className="primary" onClick={() => answer(true)} disabled={!armed}>
            Submit application
          </button>
        </div>
      </div>
    </div>
  );
}

function secondsLeft(expiresAt: string): number {
  return Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000));
}

function formatRemaining(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}
