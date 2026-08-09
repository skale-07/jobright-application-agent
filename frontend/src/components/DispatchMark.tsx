/**
 * The Dispatch logomark — "the waypoint track": an application's route
 * through the pipeline, drawn as three stations on a rising track with the
 * final station filled (delivered — accounted for). Monoline, geometric,
 * currentColor throughout so it inherits context (accent in the sidebar,
 * text color in prose) and works in both themes with no asset variants.
 * Construction and usage rules: DESIGN.md §1.5.
 */
export function DispatchMark({
  size = 20,
  title,
}: {
  size?: number;
  title?: string;
}): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      <path
        d="M6 18 L18 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle
        cx="6"
        cy="18"
        r="2.4"
        fill="var(--bg-inset, #010409)"
        stroke="currentColor"
        strokeWidth="2"
      />
      <circle
        cx="12"
        cy="12"
        r="2.4"
        fill="var(--bg-inset, #010409)"
        stroke="currentColor"
        strokeWidth="2"
      />
      <circle cx="18" cy="6" r="3" fill="currentColor" />
    </svg>
  );
}
