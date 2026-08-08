import { useRef, useState } from "react";
import { apiGet, apiPost, apiUpload, getToken, setToken } from "../api/client";
import type { FlagsView, Summary } from "../api/types";
import { usePoll } from "../hooks/usePoll";
import { JsonView } from "../components/JsonView";

type GmailStatus = {
  flow_status: string;
  token_present: boolean;
  account_email: string | null;
  verification_enabled: boolean;
};

export function SettingsPage(): JSX.Element {
  const flags = usePoll<FlagsView>(() => apiGet<FlagsView>("/api/flags"), 30000);
  const summary = usePoll<Summary>(() => apiGet<Summary>("/api/summary"), 30000);
  const gmail = usePoll<GmailStatus>(
    () => apiGet<GmailStatus>("/api/gmail/status"),
    5000,
  );

  return (
    <>
      <div className="page-head">
        <h1>Settings</h1>
        <div className="sub">token, capabilities, mailbox, materials</div>
      </div>

      <TokenCard />
      <CapabilitiesCard flags={flags.data} summary={summary.data} />
      <GmailCard status={gmail.data} onChanged={gmail.refresh} />
      <MaterialsCard />
    </>
  );
}

function TokenCard(): JSX.Element {
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState(false);
  const present = getToken() !== null;

  return (
    <div className="card">
      <h2>Console token</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Mutations need the per-boot token printed when the console started. It
        normally arrives in the <code>#token=</code> fragment of the startup
        URL; paste it here if you opened the console in a fresh tab.
      </p>
      <div className="toolbar" style={{ marginBottom: 0 }}>
        <span className={`badge ${present ? "ok" : "warn"}`}>
          {present ? "token stored" : "no token"}
        </span>
        <input
          type="password"
          placeholder="64-character hex token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          style={{ minWidth: "22rem" }}
        />
        <button
          onClick={() => {
            setToken(value);
            setValue("");
            setSaved(true);
          }}
          disabled={value.trim().length === 0}
        >
          Save
        </button>
        {saved ? <span className="faint">stored for this tab</span> : null}
      </div>
    </div>
  );
}

function CapabilitiesCard({
  flags,
  summary,
}: {
  flags: FlagsView | null;
  summary: Summary | null;
}): JSX.Element {
  return (
    <div className="card">
      <h2>Capability ceiling</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        These come from the shell that started the console. A run receives a
        flag only if it is enabled here <em>and</em> you opt into it when
        launching. Restart the console with different env to change them.
      </p>
      {flags ? (
        <>
          <table>
            <tbody>
              {Object.entries(flags.ceiling)
                .sort()
                .map(([key, on]) => (
                  <tr key={key}>
                    <td className="mono">{key}</td>
                    <td>
                      <span className={`badge ${on ? "ok" : "neutral"}`}>
                        {on ? "available" : "off"}
                      </span>
                    </td>
                  </tr>
                ))}
              <tr>
                <td className="mono">LIVE_MODE (DRY_RUN=false)</td>
                <td>
                  <span className={`badge ${flags.live_mode_available ? "ok" : "neutral"}`}>
                    {flags.live_mode_available ? "available" : "off"}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
          <div style={{ marginTop: "0.75rem" }}>
            <JsonView value={flags.always_forced} label="always forced for console runs" />
          </div>
        </>
      ) : (
        <p className="faint">Loading…</p>
      )}
      {summary ? (
        <p className="faint mono" style={{ marginBottom: 0 }}>
          database: {summary.database}
        </p>
      ) : null}
    </div>
  );
}

function GmailCard({
  status,
  onChanged,
}: {
  status: GmailStatus | null;
  onChanged: () => void;
}): JSX.Element {
  const [email, setEmail] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [consentUrl, setConsentUrl] = useState<string | null>(null);
  const [redirectUrl, setRedirectUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const start = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<{ consentUrl: string }>("/api/gmail/auth/start", {
        email,
        ...(clientId ? { client_id: clientId } : {}),
        ...(clientSecret ? { client_secret: clientSecret } : {}),
      });
      setConsentUrl(res.consentUrl);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const finish = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<{ token_path: string }>(
        "/api/gmail/auth/redirect-url",
        { url: redirectUrl },
      );
      setResult(`readonly token stored at ${res.token_path}`);
      setConsentUrl(null);
      setRedirectUrl("");
      setClientSecret("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const check = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<{ account_email: string; recent_message_count: number }>(
        "/api/gmail/check",
      );
      setResult(
        `${res.account_email}: ${res.recent_message_count} message(s) in the last day`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>Gmail (readonly verification)</h2>
      {error ? <div className="banner danger">{error}</div> : null}
      {result ? <div className="banner ok">{result}</div> : null}
      <div className="toolbar">
        <span className={`badge ${status?.token_present ? "ok" : "neutral"}`}>
          {status?.token_present ? `token: ${status.account_email}` : "no token"}
        </span>
        <span className={`badge ${status?.verification_enabled ? "ok" : "neutral"}`}>
          GMAIL_VERIFICATION_ENABLED {status?.verification_enabled ? "on" : "off"}
        </span>
        <button onClick={() => void check()} disabled={busy}>
          Run read-only check
        </button>
      </div>

      {consentUrl ? (
        <div style={{ display: "grid", gap: "0.6rem" }}>
          <p className="muted" style={{ margin: 0 }}>
            Open the consent URL, approve, then paste the localhost URL you land
            on (it will fail to load — that is expected).
          </p>
          <a href={consentUrl} target="_blank" rel="noreferrer" className="mono">
            open Google consent →
          </a>
          <label className="field">
            Pasted redirect URL
            <input
              value={redirectUrl}
              onChange={(e) => setRedirectUrl(e.target.value)}
              placeholder="http://localhost:8791/cb?code=…"
            />
          </label>
          <div>
            <button
              className="primary"
              onClick={() => void finish()}
              disabled={busy || redirectUrl.trim().length === 0}
            >
              Finish setup
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: "0.6rem" }}>
          <label className="field">
            Mailbox
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@gmail.com"
            />
          </label>
          <label className="field">
            OAuth client id <span className="faint">(or set GMAIL_OAUTH_CLIENT_ID)</span>
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} />
          </label>
          <label className="field">
            OAuth client secret{" "}
            <span className="faint">(or set GMAIL_OAUTH_CLIENT_SECRET)</span>
            <input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
            />
          </label>
          <div>
            <button
              onClick={() => void start()}
              disabled={busy || email.trim().length === 0}
            >
              Start OAuth flow
            </button>
          </div>
          <p className="faint" style={{ margin: 0 }}>
            Scope is pinned to gmail.readonly; a grant carrying anything wider is
            refused before it is stored.
          </p>
        </div>
      )}
    </div>
  );
}

function MaterialsCard(): JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null);
  const [applicationId, setApplicationId] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(null);

  const upload = async (): Promise<void> => {
    const file = fileRef.current?.files?.[0];
    if (!file || !applicationId.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setResult(
        await apiUpload("/api/materials/upload", file, {
          "x-application-id": applicationId.trim(),
          "x-filename": file.name,
          ...(label.trim() ? { "x-label": label.trim() } : {}),
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>Register a resume</h2>
      {error ? <div className="banner danger">{error}</div> : null}
      <div style={{ display: "grid", gap: "0.6rem" }}>
        <label className="field">
          Application ID
          <input
            value={applicationId}
            onChange={(e) => setApplicationId(e.target.value)}
            placeholder="uuid"
          />
        </label>
        <label className="field">
          Label (optional)
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="swe" />
        </label>
        <label className="field">
          Resume PDF
          <input type="file" accept="application/pdf" ref={fileRef} />
        </label>
        <div>
          <button
            className="primary"
            onClick={() => void upload()}
            disabled={busy || applicationId.trim().length === 0}
          >
            Upload &amp; register
          </button>
        </div>
      </div>
      {result ? (
        <div style={{ marginTop: "1rem" }}>
          <JsonView value={result} label="registered material" open />
        </div>
      ) : null}
    </div>
  );
}
