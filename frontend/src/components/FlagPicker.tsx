import type { FlagsView } from "../api/types";

/**
 * Per-run flag opt-in. The ceiling comes from the shell that started the
 * console — flags it does not carry are shown greyed out and cannot be
 * enabled here. The UI can only narrow what a run gets, never widen it.
 */
export function FlagPicker({
  flags,
  selected,
  liveMode,
  onToggleFlag,
  onToggleLive,
}: {
  flags: FlagsView;
  selected: Record<string, boolean>;
  liveMode: boolean;
  onToggleFlag: (key: string, value: boolean) => void;
  onToggleLive: (value: boolean) => void;
}): JSX.Element {
  const keys = Object.keys(flags.ceiling).sort();
  const available = keys.filter((k) => flags.ceiling[k]);
  const denied = keys.filter((k) => !flags.ceiling[k]);

  return (
    <div>
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
          checked={liveMode}
          disabled={!flags.live_mode_available}
          onChange={(e) => onToggleLive(e.target.checked)}
        />
        <span>
          Live mode <span className="faint mono">(DRY_RUN=false)</span>
        </span>
        {!flags.live_mode_available ? (
          <span className="badge neutral">shell is dry-run</span>
        ) : null}
      </label>

      {available.length === 0 ? (
        <p className="faint" style={{ margin: "0 0 0.5rem" }}>
          The console shell carries no capability flags — runs will be
          read-only. Restart the console with the flags you need.
        </p>
      ) : (
        <div style={{ display: "grid", gap: "0.35rem", marginBottom: "0.6rem" }}>
          {available.map((key) => (
            <label
              key={key}
              style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}
            >
              <input
                type="checkbox"
                checked={selected[key] === true}
                onChange={(e) => onToggleFlag(key, e.target.checked)}
              />
              <span className="mono">{key}</span>
            </label>
          ))}
        </div>
      )}

      {denied.length > 0 ? (
        <details className="json-block">
          <summary>{denied.length} flag(s) unavailable in this shell</summary>
          <div style={{ display: "grid", gap: "0.2rem" }}>
            {denied.map((key) => (
              <span key={key} className="mono faint">
                {key}
              </span>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
