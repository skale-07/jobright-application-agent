import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiPost } from "../api/client";
import type { ApplicationDetail } from "../api/types";
import { EmptyState } from "./EmptyState";

/**
 * X6: the whole outreach pipeline as three plain buttons — no CLI. Each
 * button launches a bounded console run (child process, own gates) and
 * jumps to its live log. Step order is enforced by enablement: emails
 * need contacts, drafts need a validated email. LLM-written content
 * renders with the purple accent per DESIGN.md.
 */
export function OutreachCard(props: {
  applicationId: string;
  detail: ApplicationDetail;
}): JSX.Element {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openEmail, setOpenEmail] = useState<string | null>(null);

  const contacts = props.detail.contacts ?? [];
  const emails = props.detail.email_generations ?? [];
  const validated = emails.filter((e) => e["validation_status"] === "VALIDATED");
  const gmailDrafts = props.detail.gmail_drafts ?? [];
  const outlookDrafts = props.detail.drafts ?? [];

  const start = async (
    kind: "contacts" | "email" | "gmail_draft",
    flag: string,
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<{ run_id: string }>("/api/runs", {
        kind,
        params: { application_id: props.applicationId, headed: true },
        flags: { [flag]: true },
        live_mode: false,
      });
      navigate(`/runs/${res.run_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>Outreach</h2>
      <p className="faint" style={{ marginTop: 0 }}>
        Find people at the company, write them an email, save it as a Gmail
        draft. Nothing ever sends — you review drafts in Gmail.
      </p>
      {error ? <div className="banner danger">{error}</div> : null}
      <div className="toolbar" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
        <button
          disabled={busy}
          onClick={() => void start("contacts", "LINKEDIN_ENRICHMENT_ENABLED")}
        >
          1 · Find insider emails
        </button>
        <button
          disabled={busy || contacts.length === 0}
          title={contacts.length === 0 ? "Find insider emails first" : undefined}
          onClick={() => void start("email", "EMAIL_GENERATION_ENABLED")}
        >
          2 · Write outreach emails
        </button>
        <button
          disabled={busy || validated.length === 0}
          title={validated.length === 0 ? "Write emails first" : undefined}
          onClick={() => void start("gmail_draft", "GMAIL_DRAFTS_ENABLED")}
        >
          3 · Save Gmail drafts
        </button>
      </div>

      {contacts.length > 0 ? (
        <div className="table-wrap" style={{ marginTop: "0.75rem" }}>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={String(c["id"])}>
                  <td>{String(c["name"] ?? "") || <span className="faint">unknown</span>}</td>
                  <td className="mono">{String(c["email"] ?? "") || "—"}</td>
                  <td>{String(c["source_category"] ?? "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          icon="mail"
          title="No contacts yet"
          body="Step 1 finds people at this company who can refer you."
        />
      )}

      {emails.length > 0 ? (
        <div style={{ marginTop: "0.75rem", display: "grid", gap: "0.5rem" }}>
          {emails.map((e) => {
            const id = String(e["id"]);
            const ok = e["validation_status"] === "VALIDATED";
            return (
              <div
                key={id}
                style={{
                  borderLeft: "3px solid var(--purple)",
                  paddingLeft: "0.75rem",
                }}
              >
                <button
                  className="ghost"
                  onClick={() => setOpenEmail(openEmail === id ? null : id)}
                >
                  {openEmail === id ? "▾" : "▸"} {String(e["subject"] ?? "(no subject)")}
                </button>{" "}
                <span className={`badge ${ok ? "ok" : "danger"}`}>
                  {String(e["validation_status"])}
                </span>
                {openEmail === id ? (
                  <pre
                    className="mono"
                    style={{ whiteSpace: "pre-wrap", marginTop: "0.5rem" }}
                  >
                    {String(e["body_text"] ?? "")}
                  </pre>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {gmailDrafts.length + outlookDrafts.length > 0 ? (
        <div style={{ marginTop: "0.75rem" }}>
          <h3 style={{ margin: "0 0 0.25rem" }}>Drafts</h3>
          <ul style={{ margin: 0 }}>
            {gmailDrafts.map((d) => (
              <li key={`g-${String(d["id"])}`}>
                Gmail → <span className="mono">{String(d["recipient_email"])}</span>{" "}
                <span className={`badge ${d["verified"] ? "ok" : "warn"}`}>
                  {String(d["status"])}
                  {d["verified"] ? " · verified" : ""}
                </span>
              </li>
            ))}
            {outlookDrafts.map((d) => (
              <li key={`o-${String(d["id"])}`}>
                Outlook → <span className="mono">{String(d["recipient_email"])}</span>{" "}
                <span className={`badge ${d["verified"] ? "ok" : "warn"}`}>
                  {String(d["status"])}
                  {d["verified"] ? " · verified" : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
