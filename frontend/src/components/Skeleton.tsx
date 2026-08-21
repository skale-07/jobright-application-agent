/**
 * Loading placeholders that mirror the shape of what's arriving.
 *
 * The console used to print the word "Loading…" in grey in seven places.
 * A skeleton that matches the real layout reads as faster than a spinner
 * or a sentence even at identical latency, because the page stops
 * reflowing when the data lands. The pulse is state, not decoration —
 * it means "still waiting", and it stops the moment content replaces it.
 */
export function Skeleton(props: {
  width?: string;
  height?: string;
  className?: string;
}): JSX.Element {
  return (
    <span
      className={`skeleton ${props.className ?? ""}`}
      style={{ width: props.width ?? "100%", height: props.height ?? "0.9em" }}
      aria-hidden
    />
  );
}

/** A card-shaped placeholder: eyebrow heading plus a few text lines. */
export function SkeletonCard(props: { lines?: number; title?: boolean }): JSX.Element {
  const lines = props.lines ?? 3;
  return (
    <div className="card" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      {props.title === false ? null : (
        <Skeleton width="8rem" height="0.8em" className="skeleton-title" />
      )}
      <div className="skeleton-lines">
        {Array.from({ length: lines }, (_, i) => (
          <Skeleton
            key={i}
            // Ragged line lengths read as text; identical bars read as a
            // loading graphic, which is the thing being replaced.
            width={`${[92, 78, 85, 64, 88][i % 5]}%`}
          />
        ))}
      </div>
    </div>
  );
}

/** A table-shaped placeholder matching an existing column count. */
export function SkeletonTable(props: { rows?: number; cols?: number }): JSX.Element {
  const rows = props.rows ?? 5;
  const cols = props.cols ?? 4;
  return (
    <div className="table-wrap" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      <table>
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r}>
              {Array.from({ length: cols }, (_, c) => (
                <td key={c}>
                  <Skeleton width={c === 0 ? "70%" : "45%"} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
