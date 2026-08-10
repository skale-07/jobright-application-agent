import { useState } from "react";
import { apiPost } from "../api/client";
import type { ReviewItemView } from "../api/types";

/**
 * Kind-dispatched resolution, mirroring the server's action matrix. The
 * server re-checks the matrix and the application's current state, so a
 * stale panel can never force an illegal transition.
 */
const ACTIONS: Record<string, Array<{ action: string; label: string; tone?: string }>> = {
  UNCERTAIN_SUBMISSION: [
    { action: "submitted", label: "It was submitted", tone: "primary" },
    { action: "not-submitted", label: "Nothing was submitted" },
    { action: "dismiss", label: "Dismiss" },
  ],
  AUTH_REQUIRED: [
    { action: "requeue", label: "Wall cleared — requeue", tone: "primary" },
    { action: "abandon", label: "Abandon", tone: "danger" },
    { action: "dismiss", label: "Dismiss" },
  ],
  CAPTCHA_REQUIRED: [
    { action: "requeue", label: "Captcha solved — requeue", tone: "primary" },
    { action: "abandon", label: "Abandon", tone: "danger" },
    { action: "dismiss", label: "Dismiss" },
  ],
  UNSUPPORTED_ATS: [
    { action: "requeue", label: "Requeue with URL", tone: "primary" },
    { action: "abandon", label: "Abandon", tone: "danger" },
    { action: "dismiss", label: "Dismiss" },
  ],
  AMBIGUOUS_FIELD: [
    { action: "requeue", label: "Resolved — re-verify", tone: "primary" },
    { action: "abandon", label: "Abandon", tone: "danger" },
    { action: "dismiss", label: "Dismiss" },
  ],
  ESSAY: [{ action: "dismiss", label: "Dismiss" }],
  MANUAL: [{ action: "dismiss", label: "Dismiss" }],
  DUPLICATE_RISK: [{ action: "dismiss", label: "Dismiss" }],
};

export function ReviewActionPanel({
  item,
  onResolved,
}: {
  item: ReviewItemView;
  onResolved: () => void;
}): JSX.Element {
  const [note, setNote] = useState("");
  const [employerUrl, setEmployerUrl] = useState("");
  const [requeue, setRequeue] = useState(true);
  const [essayField, setEssayField] = useState("");
  const [essayText, setEssayText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const isPrediction =
    item.kind === "MANUAL" && item.payload?.["source"] === "screener_prediction";
  const [predAnswer, setPredAnswer] = useState<string>(
    typeof item.payload?.["predicted_answer"] === "string"
      ? (item.payload["predicted_answer"] as string)
      : "",
  );
  const predOptions = Array.isArray(item.payload?.["options"])
    ? (item.payload["options"] as unknown[]).filter(
        (o): o is string => typeof o === "string",
      )
    : [];

  const actions = ACTIONS[item.kind] ?? [{ action: "dismiss", label: "Dismiss" }];
  const essayFields = essayFieldIds(item);

  const promote = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<{ bank_key: string; saved_answer: string }>(
        `/api/review-items/${item.id}/resolve`,
        { action: "promote-screener", answer: predAnswer },
      );
      setResult(
        `saved "${res.saved_answer}" — this question now fills automatically on every form`,
      );
      onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const run = async (action: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { action };
      if (note.trim()) body["note"] = note.trim();
      if (action === "not-submitted") body["requeue"] = requeue;
      if (item.kind === "UNSUPPORTED_ATS" && employerUrl.trim()) {
        body["employer_url"] = employerUrl.trim();
      }
      const res = await apiPost<{ application_state: string | null; transition_skipped: string | null }>(
        `/api/review-items/${item.id}/resolve`,
        body,
      );
      setResult(
        res.transition_skipped
          ? `resolved — ${res.transition_skipped}`
          : `resolved — application is now ${res.application_state ?? "unchanged"}`,
      );
      onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const saveEssay = async (): Promise<void> => {
    if (!item.application_id || !essayField || !essayText.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<{ review_resolved: boolean; unanswered_fields: string[] }>(
        "/api/essays/answer",
        {
          application_id: item.application_id,
          field_key: essayField,
          text: essayText,
        },
      );
      setResult(
        res.review_resolved
          ? "all essays answered — item resolved"
          : `saved — still unanswered: ${res.unanswered_fields.join(", ")}`,
      );
      setEssayText("");
      onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: "0.75rem" }}>
      {error ? <div className="banner danger">{error}</div> : null}
      {result ? <div className="banner ok">{result}</div> : null}

      {item.kind === "ESSAY" && essayFields.length > 0 ? (
        <div style={{ display: "grid", gap: "0.5rem", marginBottom: "0.75rem" }}>
          <label className="field">
            Essay field
            <select
              value={essayField}
              onChange={(e) => {
                const next = e.target.value;
                setEssayField(next);
                // Pre-fill from the AI suggestion when one exists and the
                // operator hasn't typed anything — edit-or-approve, never
                // silently submitted.
                const drafts = item.payload?.["essay_drafts"] as
                  | Record<string, string>
                  | undefined;
                if (drafts?.[next] && essayText.trim() === "") {
                  setEssayText(drafts[next]);
                }
              }}
            >
              <option value="">choose a field…</option>
              {essayFields.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          {(item.payload?.["essay_drafts"] as Record<string, string> | undefined)?.[essayField] ? (
            <p className="mono" style={{ fontSize: "11.5px", color: "var(--purple)", margin: 0 }}>
              pre-filled from AI draft (UNVERIFIED) — edit to make it yours before saving
            </p>
          ) : null}
          <label className="field">
            Your answer (yours to approve — drafts are suggestions)
            <textarea
              rows={6}
              value={essayText}
              onChange={(e) => setEssayText(e.target.value)}
            />
          </label>
          <div>
            <button
              className="primary"
              onClick={() => void saveEssay()}
              disabled={busy || !essayField || essayText.trim().length === 0}
            >
              Save answer
            </button>
          </div>
        </div>
      ) : null}

      {isPrediction ? (
        <div style={{ display: "grid", gap: "0.5rem", marginBottom: "0.75rem" }}>
          <p className="muted" style={{ margin: 0 }}>
            {String(item.payload?.["question"] ?? "")}
          </p>
          {typeof item.payload?.["basis"] === "string" && item.payload["basis"] ? (
            <p className="mono" style={{ fontSize: "11.5px", color: "var(--purple)", margin: 0 }}>
              AI suggestion (UNVERIFIED), based on: {item.payload["basis"] as string}
            </p>
          ) : null}
          <label className="field">
            Your answer (approving saves it for every future form)
            {predOptions.length > 0 ? (
              <select value={predAnswer} onChange={(e) => setPredAnswer(e.target.value)}>
                {predOptions.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <input value={predAnswer} onChange={(e) => setPredAnswer(e.target.value)} />
            )}
          </label>
          <div>
            <button
              className="primary"
              onClick={() => void promote()}
              disabled={busy || predAnswer.trim().length === 0}
            >
              Approve &amp; save answer
            </button>
          </div>
        </div>
      ) : null}

      {item.kind === "UNSUPPORTED_ATS" ? (
        <label className="field" style={{ marginBottom: "0.6rem" }}>
          Corrected employer URL (validated against supported ATSes)
          <input
            value={employerUrl}
            onChange={(e) => setEmployerUrl(e.target.value)}
            placeholder="https://boards.greenhouse.io/…"
          />
        </label>
      ) : null}

      {item.kind === "UNCERTAIN_SUBMISSION" ? (
        <label
          style={{
            display: "flex",
            gap: "0.5rem",
            alignItems: "center",
            marginBottom: "0.6rem",
          }}
        >
          <input
            type="checkbox"
            checked={requeue}
            onChange={(e) => setRequeue(e.target.checked)}
          />
          <span className="muted">requeue after "nothing was submitted"</span>
        </label>
      ) : null}

      <label className="field" style={{ marginBottom: "0.6rem" }}>
        Note (optional)
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </label>

      <div className="toolbar" style={{ marginBottom: 0 }}>
        {actions.map((a) => (
          <button
            key={a.action}
            className={a.tone ?? ""}
            onClick={() => void run(a.action)}
            disabled={busy}
          >
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function essayFieldIds(item: ReviewItemView): Array<{ id: string; label: string }> {
  const essays = item.payload?.["essays"];
  if (!Array.isArray(essays)) return [];
  return essays
    .map((e) => e as { field_id?: unknown; label?: unknown })
    .filter((e) => typeof e.field_id === "string")
    .map((e) => ({
      id: e.field_id as string,
      label:
        typeof e.label === "string" && e.label.length > 0
          ? `${e.label} (${e.field_id as string})`
          : (e.field_id as string),
    }));
}
