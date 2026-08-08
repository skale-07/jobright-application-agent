import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiGet } from "../api/client";
import type { ApplicationsPage as Page } from "../api/types";
import { usePoll } from "../hooks/usePoll";
import { StateBadge } from "../components/StateBadge";

const PAGE_SIZE = 100;

export function ApplicationsPage(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const state = params.get("state") ?? "";
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [offset, setOffset] = useState(0);

  const qs = new URLSearchParams();
  if (state) qs.set("state", state);
  if (params.get("q")) qs.set("q", params.get("q")!);
  qs.set("limit", String(PAGE_SIZE));
  qs.set("offset", String(offset));

  const { data, error, loading } = usePoll<Page>(
    () => apiGet<Page>(`/api/applications?${qs.toString()}`),
    5000,
    [qs.toString()],
  );

  const applyFilters = (next: { state?: string; q?: string }): void => {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v) merged.set(k, v);
      else merged.delete(k);
    }
    setOffset(0);
    setParams(merged);
  };

  return (
    <>
      <div className="page-head">
        <h1>Applications</h1>
        <div className="sub">{data ? `${data.total} matching` : ""}</div>
      </div>

      <div className="toolbar">
        <input
          type="search"
          placeholder="company, role, or application id…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") applyFilters({ q: query });
          }}
        />
        <button onClick={() => applyFilters({ q: query })}>Search</button>
        {state ? (
          <button className="ghost" onClick={() => applyFilters({ state: "" })}>
            clear state: {state} ✕
          </button>
        ) : null}
        {params.get("q") ? (
          <button
            className="ghost"
            onClick={() => {
              setQuery("");
              applyFilters({ q: "" });
            }}
          >
            clear search ✕
          </button>
        ) : null}
      </div>

      {error ? <div className="banner danger">{error}</div> : null}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Company</th>
              <th>Role</th>
              <th>State</th>
              <th>Attempt</th>
              <th>Updated</th>
              <th className="mono">ID</th>
            </tr>
          </thead>
          <tbody>
            {(data?.rows ?? []).map((row) => (
              <tr key={row.id}>
                <td>
                  <Link to={`/applications/${row.id}`}>{row.company ?? "—"}</Link>
                </td>
                <td className="muted">{row.role ?? "—"}</td>
                <td>
                  <StateBadge value={row.state} />
                </td>
                <td className="mono">{row.attempt}</td>
                <td className="mono faint nowrap">
                  {new Date(row.updated_at).toLocaleString()}
                </td>
                <td className="mono faint">{row.id.slice(0, 8)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && (data?.rows.length ?? 0) === 0 ? (
          <div className="empty">No applications match these filters.</div>
        ) : null}
      </div>

      {(data?.total ?? 0) > PAGE_SIZE ? (
        <div className="toolbar" style={{ marginTop: "1rem" }}>
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
            ← Previous
          </button>
          <span className="faint mono">
            {offset + 1}–{Math.min(offset + PAGE_SIZE, data?.total ?? 0)} of {data?.total}
          </span>
          <button
            disabled={offset + PAGE_SIZE >= (data?.total ?? 0)}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            Next →
          </button>
        </div>
      ) : null}
    </>
  );
}
