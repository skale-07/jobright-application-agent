import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

/**
 * An empty state is a designed moment, not a missing one.
 *
 * Two kinds exist in this console and they must not look alike:
 *   tone="good"    — nothing here BECAUSE everything is handled. The
 *                    empty inbox is the goal state; it should read as
 *                    reassurance, not absence.
 *   tone="waiting" — nothing here YET. This is the onboarding surface,
 *                    so it names the one action that fills it.
 *
 * Replaces the bare `<p className="faint">nothing</p>` that stood in for
 * every zero state.
 */
export function EmptyState(props: {
  icon?: IconName;
  title: string;
  body?: string;
  tone?: "good" | "waiting";
  action?: ReactNode;
}): JSX.Element {
  const tone = props.tone ?? "waiting";
  return (
    <div className={`empty-state empty-${tone}`}>
      <Icon name={props.icon ?? (tone === "good" ? "check" : "inbox")} size={22} />
      <h3>{props.title}</h3>
      {props.body ? <p>{props.body}</p> : null}
      {props.action ? <div className="empty-action">{props.action}</div> : null}
    </div>
  );
}
