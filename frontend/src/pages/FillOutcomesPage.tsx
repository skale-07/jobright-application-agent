import { apiGet } from "../api/client";
import type { FillOutcomesView } from "../api/types";
import { usePoll } from "../hooks/usePoll";
import { JsonView } from "../components/JsonView";
import { SkeletonTable } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";

function num(row: Record<string, unknown>, key: string): number {
  const v = row[key];
  return typeof v === "number" ? v : 0;
}

export function FillOutcomesPage(): JSX.Element {
  const { data, error, loading } = usePoll<FillOutcomesView>(
    () => apiGet<FillOutcomesView>("/api/fill-outcomes"),
    10000,
  );

  if (loading && !data) return <SkeletonTable rows={6} cols={8} />;
  if (error) return <div className="banner danger">{error}</div>;
  if (!data) return <p className="faint">No data.</p>;

  const rates = data.success_rates;

  return (
    <>
      <div className="page-head">
        <h1>Fill outcomes</h1>
        <div className="sub">per-field success rates across recorded fill runs</div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ATS</th>
              <th>Field</th>
              <th>Canonical</th>
              <th>Control</th>
              <th className="num">Attempts</th>
              <th className="num">Fill ok</th>
              <th className="num">Verified</th>
              <th className="num">Verify fail</th>
            </tr>
          </thead>
          <tbody>
            {rates.map((r, i) => {
              const attempts = num(r, "attempts");
              const verified = num(r, "verify_match_count");
              const failed = num(r, "verify_fail_count");
              return (
                <tr key={`${String(r["label"])}-${i}`}>
                  <td className="mono">{String(r["ats"] ?? "—")}</td>
                  <td>{String(r["label"] ?? "—")}</td>
                  <td className="mono faint">{String(r["canonical_field"] ?? "—")}</td>
                  <td className="mono faint">{String(r["control_kind"] ?? "—")}</td>
                  <td className="mono num">
                    {attempts}
                  </td>
                  <td className="mono num">
                    {num(r, "fill_ok_count")}
                  </td>
                  <td
                    className="mono"
                    style={{ textAlign: "right", color: verified > 0 ? "var(--ok)" : undefined }}
                  >
                    {verified}
                  </td>
                  <td
                    className="mono"
                    style={{ textAlign: "right", color: failed > 0 ? "var(--danger)" : undefined }}
                  >
                    {failed}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rates.length === 0 ? (
          <EmptyState
            icon="file"
            title="No fill runs recorded yet"
            body="Per-field accuracy appears once Dispatch has filled at least one form."
          />
        ) : null}
      </div>

      <div className="card">
        <JsonView value={data.summary} label="summary" />
      </div>
    </>
  );
}
