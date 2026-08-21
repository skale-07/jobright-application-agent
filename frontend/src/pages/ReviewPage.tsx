import { Link } from "react-router-dom";
import { apiGet } from "../api/client";
import type { ReviewItemView } from "../api/types";
import { usePoll } from "../hooks/usePoll";
import { StateBadge } from "../components/StateBadge";
import { JsonView } from "../components/JsonView";
import { ReviewActionPanel } from "../components/ReviewActionPanel";
import { describeReviewItem, jobLabel } from "../lib/plainLanguage";

export function ReviewPage(): JSX.Element {
  const { data, error, loading, refresh } = usePoll<ReviewItemView[]>(
    () => apiGet<ReviewItemView[]>("/api/review-items"),
    5000,
  );

  const items = data ?? [];
  const byKind = new Map<string, ReviewItemView[]>();
  for (const item of items) {
    const list = byKind.get(item.kind) ?? [];
    list.push(item);
    byKind.set(item.kind, list);
  }

  return (
    <>
      <div className="page-head">
        <h1>Needs you</h1>
        <div className="sub">
          {items.length} thing{items.length === 1 ? "" : "s"} waiting on a human
        </div>
      </div>

      {error ? <div className="banner danger">{error}</div> : null}
      {!loading && items.length === 0 ? (
        <div className="card">
          <p className="faint flush">
            Nothing waiting on you.
          </p>
        </div>
      ) : null}

      {[...byKind.entries()].map(([kind, list]) => (
        <div className="card" key={kind}>
          <h2>
            <StateBadge value={kind} kind="review" /> · {list.length}
          </h2>
          {list.map((item) => (
            <div
              key={item.id}
              style={{
                borderTop: "1px solid var(--border)",
                paddingTop: "0.75rem",
                marginTop: "0.75rem",
              }}
            >
              <div className="t-head">
                <strong>{describeReviewItem(item).action}</strong>
                <span className="t-when">
                  {new Date(item.created_at).toLocaleString()}
                </span>
              </div>
              <div className="muted" style={{ marginTop: "0.2rem", fontSize: "12.5px" }}>
                {describeReviewItem(item).why}
              </div>
              {item.application_id ? (
                <div style={{ marginTop: "0.3rem" }}>
                  <Link to={`/applications/${item.application_id}`}>
                    {jobLabel(item)}
                  </Link>
                  <span className="faint" style={{ fontSize: "11.5px" }}>
                    {" "}
                    · {item.title}
                  </span>
                </div>
              ) : (
                <div className="faint mono">service-level item</div>
              )}
              {item.payload && Object.keys(item.payload).length > 0 ? (
                <div style={{ marginTop: "0.5rem" }}>
                  <JsonView value={item.payload} label="payload" />
                </div>
              ) : null}
              <ReviewActionPanel item={item} onResolved={refresh} />
            </div>
          ))}
        </div>
      ))}
    </>
  );
}
