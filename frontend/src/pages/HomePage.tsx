import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiGet, apiPost } from "../api/client";
import type { ReviewItemView, Summary } from "../api/types";
import { usePoll } from "../hooks/usePoll";
import { formatCountdown, useArmStatus } from "../hooks/useArmStatus";
import { describeReviewItem, jobLabel } from "../lib/plainLanguage";
import { ARM_DEFAULTS, AUTOMATION_RUN_BODY } from "../lib/automationRun";

/**
 * Home — the non-technical front door. One question per section:
 *   "Is Dispatch working right now?"  → hero with one button
 *   "What does it need from me?"      → plain-language to-do list
 *   "What has it done?"               → submitted list
 *   "Is everything set up?"           → readiness checklist
 * All state-machine and flag vocabulary stays on the advanced pages.
 */

type SubmissionRow = {
  id: string;
  application_id: string;
  submitted: number | boolean;
  submitted_at: string | null;
  company: string | null;
  role: string | null;
};

export function HomePage(): JSX.Element {
  const navigate = useNavigate();
  const { status: arm, refresh: refreshArm } = useArmStatus();
  const summary = usePoll<Summary>(() => apiGet<Summary>("/api/summary"), 8000);
  const reviews = usePoll<ReviewItemView[]>(
    () => apiGet<ReviewItemView[]>("/api/review-items"),
    5000,
  );
  const submissions = usePoll<SubmissionRow[]>(
    () => apiGet<SubmissionRow[]>("/api/submissions"),
    15000,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const armed = arm?.armed === true;

  const startSession = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/automation/arm", ARM_DEFAULTS);
      refreshArm();
      const res = await apiPost<{ run_id: string }>("/api/runs", AUTOMATION_RUN_BODY);
      navigate(`/runs/${res.run_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const stopSession = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/automation/disarm");
      refreshArm();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const todo = (reviews.data ?? [])
    .map((item) => ({ item, plain: describeReviewItem(item) }))
    .sort((a, b) => a.plain.weight - b.plain.weight)
    .slice(0, 8);
  const todoTotal = reviews.data?.length ?? 0;

  const submitted = (submissions.data ?? [])
    .filter((s) => s.submitted === 1 || s.submitted === true)
    .slice(0, 6);

  const readiness = buildReadiness(summary.data ?? null);
  const notReady = readiness.filter((r) => !r.ok);

  return (
    <>
      {error ? <div className="banner danger">{error}</div> : null}

      <div className="card hero-card">
        {armed && arm ? (
          <>
            <h1 className="hero-title">Dispatch is applying for you</h1>
            <p className="muted">
              It finds jobs, fills the forms, and submits — pausing to ask
              whenever something needs a human. You can close this tab; it
              keeps going.
            </p>
            <div className="stat-row" style={{ margin: "0.75rem 0" }}>
              <div className="stat">
                <div className="label">time left</div>
                <div className="value">{formatCountdown(arm.seconds_remaining)}</div>
              </div>
              <div className="stat">
                <div className="label">applications worked</div>
                <div className="value">
                  {arm.apps_started}
                  <span className="faint"> / {arm.max_apps}</span>
                </div>
              </div>
              <div className="stat">
                <div className="label">submitted this session</div>
                <div className="value">
                  {arm.submits_used}
                  <span className="faint"> / {arm.max_submits}</span>
                </div>
              </div>
            </div>
            <div className="toolbar" style={{ marginBottom: 0 }}>
              <button className="danger" onClick={() => void stopSession()} disabled={busy}>
                Stop applying
              </button>
              <Link to="/runs" className="btn-link">
                watch it work →
              </Link>
            </div>
          </>
        ) : (
          <>
            <h1 className="hero-title">Ready when you are</h1>
            <p className="muted">
              One click starts a two-hour session: Dispatch pulls fresh
              postings from JobRight, fills each application, and submits up
              to 10 — asking you only when a question needs a human answer.
            </p>
            {notReady.length > 0 ? (
              <div className="banner warn" style={{ margin: "0.6rem 0" }}>
                {notReady.length} setup step{notReady.length === 1 ? "" : "s"} missing
                below — sessions still run, but some abilities stay off.
              </div>
            ) : null}
            <div className="toolbar" style={{ marginBottom: 0 }}>
              <button
                className="primary hero-cta"
                onClick={() => void startSession()}
                disabled={busy}
              >
                ▶ Start applying
              </button>
              <Link to="/overview" className="btn-link">
                custom limits &amp; advanced controls →
              </Link>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h2>
          Needs you{" "}
          {todoTotal > 0 ? <span className="badge danger">{todoTotal}</span> : null}
        </h2>
        {todo.length === 0 ? (
          <p className="faint">
            Nothing — when an application needs a human (an essay, a CAPTCHA,
            a login), it shows up here as a simple to-do.
          </p>
        ) : (
          <ul className="todo-list">
            {todo.map(({ item, plain }) => (
              <li key={item.id}>
                <Link
                  to={
                    item.application_id
                      ? `/applications/${item.application_id}`
                      : "/review"
                  }
                >
                  <span className="todo-action">{plain.action}</span>
                  <span className="todo-job">{jobLabel(item)}</span>
                  <span className="todo-why">{plain.why}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {todoTotal > todo.length ? (
          <p className="faint" style={{ marginBottom: 0 }}>
            <Link to="/review">…and {todoTotal - todo.length} more</Link>
          </p>
        ) : null}
      </div>

      <div className="grid-2">
        <div className="card">
          <h2>Submitted</h2>
          {submitted.length === 0 ? (
            <p className="faint">
              Verified submissions land here with a receipt.
            </p>
          ) : (
            <ul className="done-list">
              {submitted.map((s) => (
                <li key={s.id}>
                  <Link to={`/applications/${s.application_id}`}>
                    <span className="done-check">✓</span>
                    {jobLabel(s)}
                    {s.submitted_at ? (
                      <span className="faint"> · {s.submitted_at.slice(0, 10)}</span>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card">
          <h2>Setup</h2>
          <ul className="setup-list">
            {readiness.map((r) => (
              <li key={r.label}>
                <span className={`badge ${r.ok ? "ok" : "warn"}`}>
                  {r.ok ? "ready" : "to do"}
                </span>
                <span>
                  {r.label}
                  {!r.ok && r.fix ? <span className="faint"> — {r.fix}</span> : null}
                </span>
              </li>
            ))}
          </ul>
          <p className="faint" style={{ marginBottom: 0 }}>
            <Link to="/settings">open settings →</Link>
          </p>
        </div>
      </div>
    </>
  );
}

type ReadinessRow = { label: string; ok: boolean; fix?: string };

const SERVICE_LABELS: Record<string, { label: string; fix: string }> = {
  jobright: {
    label: "JobRight login",
    fix: "log in once so Dispatch can find jobs",
  },
  outlook: {
    label: "Referral drafts (Outlook)",
    fix: "connect Outlook to prepare referral emails",
  },
  linkedin: {
    label: "LinkedIn (optional)",
    fix: "connect to find people for referrals",
  },
};

function buildReadiness(summary: Summary | null): ReadinessRow[] {
  if (!summary) return [];
  const rows: ReadinessRow[] = [];
  for (const a of summary.auth) {
    const known = SERVICE_LABELS[a.service];
    if (!known) continue;
    rows.push({ label: known.label, ok: a.ready, fix: known.fix });
  }
  rows.push({
    label: "Applying is switched on",
    ok: summary.form_fill_enabled && summary.submit_enabled && !summary.dry_run,
    fix: "start the console with applying enabled",
  });
  return rows;
}
