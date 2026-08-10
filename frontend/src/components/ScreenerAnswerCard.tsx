import { useState } from "react";
import { apiPost } from "../api/client";
import type { ReviewItemView } from "../api/types";

/**
 * The one inline "teach Dispatch an answer" control, shared by the Review
 * panel and the Home to-do list. Shows the exact question a form asked
 * (with the page's real options when it was a choice), takes the answer,
 * and saves it via the promote resolver — the sole write path into the
 * bank — so every future form fills it automatically. A model suggestion,
 * when present, only pre-fills; the human always confirms.
 */
export function isAnswerableScreenerItem(item: ReviewItemView): boolean {
  const source = item.payload?.["source"];
  return (
    item.kind === "MANUAL" &&
    (source === "screener_question" || source === "screener_prediction")
  );
}

export function ScreenerAnswerCard({
  item,
  onSaved,
}: {
  item: ReviewItemView;
  onSaved: () => void;
}): JSX.Element {
  const predicted =
    typeof item.payload?.["predicted_answer"] === "string"
      ? (item.payload["predicted_answer"] as string)
      : "";
  const [answer, setAnswer] = useState<string>(predicted);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const question = String(item.payload?.["question"] ?? item.title);
  const basis =
    typeof item.payload?.["basis"] === "string" && item.payload["basis"]
      ? (item.payload["basis"] as string)
      : null;
  const options = Array.isArray(item.payload?.["options"])
    ? (item.payload["options"] as unknown[]).filter(
        (o): o is string => typeof o === "string",
      )
    : [];

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<{ saved_answer: string }>(
        `/api/review-items/${item.id}/resolve`,
        { action: "promote-screener", answer },
      );
      setSaved(res.saved_answer);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (saved !== null) {
    return (
      <div className="banner ok" style={{ margin: 0 }}>
        Saved "{saved}" — this question now fills automatically on every form.
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: "0.5rem" }}>
      {error ? <div className="banner danger">{error}</div> : null}
      <p style={{ margin: 0, fontWeight: 600 }}>{question}</p>
      <p className="muted" style={{ margin: 0, fontSize: "12.5px" }}>
        {predicted
          ? "Dispatch suggests an answer below — approve it or change it. "
          : "Dispatch left this blank on the form because it didn't know your answer. "}
        Whatever you save fills automatically on every future application.
      </p>
      {basis ? (
        <p className="mono" style={{ fontSize: "11.5px", color: "var(--purple)", margin: 0 }}>
          AI suggestion (UNVERIFIED), based on: {basis}
        </p>
      ) : null}
      <label className="field">
        Your answer
        {options.length > 0 ? (
          <select value={answer} onChange={(e) => setAnswer(e.target.value)}>
            <option value="">choose an answer…</option>
            {options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="type the answer this form should get"
          />
        )}
      </label>
      <div>
        <button
          className="primary"
          onClick={() => void save()}
          disabled={busy || answer.trim().length === 0}
        >
          {predicted ? "Approve & save answer" : "Save answer"}
        </button>
      </div>
    </div>
  );
}
