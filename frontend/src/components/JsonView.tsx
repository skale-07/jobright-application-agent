export function JsonView({
  value,
  label = "raw JSON",
  open = false,
}: {
  value: unknown;
  label?: string;
  open?: boolean;
}): JSX.Element {
  return (
    <details className="json-block" open={open}>
      <summary>{label}</summary>
      <pre className="json mono">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
