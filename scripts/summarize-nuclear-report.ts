import fs from "node:fs";

const t = fs.readFileSync("artifacts/nuclear-execute-out.txt", "utf8");
const lines = t.split(/\r?\n/);
let start = -1;
for (let i = 0; i < lines.length; i++) {
  if (
    lines[i]?.trim() === "{" &&
    lines[i + 1]?.includes('"mode"')
  ) {
    start = i;
    break;
  }
}
if (start < 0) {
  console.error("report not found");
  process.exit(1);
}
const r = JSON.parse(lines.slice(start).join("\n"));
console.log(
  JSON.stringify(
    {
      mode: r.mode,
      validation_level: r.validation_level,
      final_url: r.final_url,
      company: r.identity_verification?.company,
      role: r.identity_verification?.role?.slice(0, 100),
      mutation_attempted: r.mutation_attempted,
      fill_filled: r.fill?.filled,
      fill_errors: r.fill?.errors,
      uploads: r.uploads,
      verify_fails: (r.verify?.fields || []).filter(
        (f: { match: boolean }) => !f.match,
      ),
      verify_pass_count: (r.verify?.fields || []).filter(
        (f: { match: boolean }) => f.match,
      ).length,
      verify_total: (r.verify?.fields || []).length,
      heal: r.heal,
      notes: r.notes,
    },
    null,
    2,
  ),
);
