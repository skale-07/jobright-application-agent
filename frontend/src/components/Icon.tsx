/**
 * The console's whole icon vocabulary — hand-drawn on one 16px grid, one
 * stroke weight, inheriting currentColor so an icon can never disagree
 * with the text beside it.
 *
 * Deliberately not an icon library: this app ships three runtime
 * dependencies on purpose, and pulling a package for fourteen glyphs
 * would be the largest dependency in the frontend. Before this, every
 * "icon" was a stray Unicode character (▶ ✓ ✕ ⏭ ⚡ ▾) typed inline, each
 * rendering at a different size and baseline depending on the platform's
 * emoji font.
 *
 * Icons are decoration for the text they sit beside: aria-hidden by
 * default. An icon-only control must carry its own aria-label.
 */
export type IconName =
  | "play"
  | "stop"
  | "check"
  | "x"
  | "skip"
  | "bolt"
  | "chevron-down"
  | "chevron-right"
  | "arrow-right"
  | "arrow-left"
  | "inbox"
  | "clock"
  | "alert"
  | "mail"
  | "file"
  | "sparkle"
  | "search";

/** [d, filled] — filled glyphs read as solid marks, stroked ones as line art. */
const PATHS: Record<IconName, [string, boolean]> = {
  play: ["M5 3.2v9.6l7.5-4.8z", true],
  stop: ["M4.5 4.5h7v7h-7z", true],
  check: ["M3 8.5 6.5 12 13 4.5", false],
  x: ["M4 4l8 8M12 4l-8 8", false],
  skip: ["M4 3.5 10 8l-6 4.5zM12 3.5v9", false],
  bolt: ["M9.2 1.5 3.8 9H7l-.2 5.5L12.2 7H9z", true],
  "chevron-down": ["M4 6.25 8 10.25l4-4", false],
  "chevron-right": ["M6.25 4 10.25 8l-4 4", false],
  "arrow-right": ["M2.5 8h11M9.5 4l4 4-4 4", false],
  "arrow-left": ["M13.5 8h-11M6.5 4l-4 4 4 4", false],
  inbox: ["M2 9.5h3l1 2h4l1-2h3M2 9.5 4 3h8l2 6.5v3.5H2z", false],
  clock: ["M8 3.2A4.8 4.8 0 1 0 8 12.8 4.8 4.8 0 0 0 8 3.2ZM8 5.5V8l2 1.5", false],
  alert: ["M8 2.5 14.5 13.5h-13zM8 6.5v3M8 11.6v.01", false],
  mail: ["M2 4h12v8H2zM2 4.5 8 9l6-4.5", false],
  file: ["M4 2h5l3 3v9H4zM9 2v3h3", false],
  sparkle: ["M8 2l1.3 3.4L12.7 6.7 9.3 8 8 11.4 6.7 8 3.3 6.7 6.7 5.4z", true],
  search: ["M7.2 2.6a4.6 4.6 0 1 0 0 9.2 4.6 4.6 0 0 0 0-9.2ZM10.6 10.6 13.8 13.8", false],
};

export function Icon(props: {
  name: IconName;
  size?: number;
  /** Only for an icon that carries meaning no adjacent text repeats. */
  label?: string;
  className?: string;
}): JSX.Element {
  const size = props.size ?? 16;
  const [d, filled] = PATHS[props.name];
  return (
    <svg
      className={props.className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : true}
      focusable="false"
    >
      <path d={d} />
    </svg>
  );
}
