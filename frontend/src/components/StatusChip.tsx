import { Icon } from "./Icon";
import { APP_STATUS, type AppStatus } from "../lib/appStatus";

/**
 * The one chip. Every surface that answers "how is this application
 * doing" renders this and nothing else, so the same application reads
 * identically on Home, on Applications, and on its own page.
 */
export function StatusChip(props: { status: AppStatus; size?: number }): JSX.Element {
  const p = APP_STATUS[props.status];
  return (
    <span className={`badge ${p.tone}`} title={p.hint}>
      <Icon name={p.icon} size={props.size ?? 12} />
      {p.label}
    </span>
  );
}
