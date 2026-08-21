import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The console's icon and status vocabularies are contracts, not
 * conventions — and both of them had already drifted once.
 *
 * Icons were stray Unicode characters (▶ ✓ ✕ ⏭ ⚡ ▾ ▸) typed inline in
 * seven files, each rendering at whatever size and baseline the host
 * platform's emoji font chose. Status was three parallel vocabularies,
 * and inside the chip set `needs-human` and `failed` were both
 * danger-red — telling the operator that a screener question they can
 * answer in ten seconds looks exactly like a crash.
 *
 * This test is text-level on purpose: frontend/ is a separate TS project
 * (JSX, DOM lib) that the backend tsconfig cannot compile, so the same
 * approach design-tokens.test.ts uses for tokens.css applies here.
 * UNIT_CONFIRMED.
 */

const SRC = path.join(process.cwd(), "frontend", "src");
const STATUS_PATH = path.join(SRC, "lib", "appStatus.ts");

/** Glyphs that were used as icons. Arrows are excluded: "Settings → §" is prose. */
const RETIRED_GLYPHS = ["▶", "✓", "✕", "⏭", "⚡", "▾", "▸", "▲", "▼"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("console icon vocabulary (UNIT_CONFIRMED)", () => {
  it("no source file renders a retired Unicode glyph", () => {
    // Icon.tsx names them in its own docblock, explaining what it replaced.
    const files = walk(SRC).filter((f) => path.basename(f) !== "Icon.tsx");
    const offenders: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      for (const glyph of RETIRED_GLYPHS) {
        if (text.includes(glyph)) {
          offenders.push(`${path.relative(SRC, file)} contains ${glyph}`);
        }
      }
    }
    expect(offenders, "use <Icon name=…/>, not a Unicode character").toEqual([]);
  });

  it("every icon the app asks for exists in the one vocabulary", () => {
    const icon = fs.readFileSync(path.join(SRC, "components", "Icon.tsx"), "utf8");
    const defined = new Set(
      [...icon.matchAll(/^\s{2}"?([a-z-]+)"?:\s*\[/gm)].map((m) => m[1]!),
    );
    expect(defined.size).toBeGreaterThanOrEqual(14);
    const used = new Set<string>();
    for (const file of walk(SRC)) {
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.matchAll(/(?:<Icon[^>]*?\s)?name[=:]\s*"([a-z-]+)"/g)) {
        // Only count names in an Icon position — icon={…} props and the
        // IconName-typed fields in appStatus.ts.
        if (defined.has(m[1]!)) used.add(m[1]!);
      }
      for (const m of text.matchAll(/icon[=:]\s*"([a-z-]+)"/g)) used.add(m[1]!);
    }
    for (const name of used) {
      expect(defined.has(name), `Icon "${name}" is defined in Icon.tsx`).toBe(true);
    }
  });
});

describe("console status vocabulary (UNIT_CONFIRMED)", () => {
  const source = fs.readFileSync(STATUS_PATH, "utf8");

  /** Pull { tone, icon, label } out of the APP_STATUS literal, per status. */
  function entries(): Record<string, { tone: string; icon: string; label: string }> {
    const block = source.match(
      /export const APP_STATUS[^=]*=\s*\{([\s\S]*?)\n\};/,
    )?.[1];
    expect(block, "APP_STATUS literal present").toBeTruthy();
    const out: Record<string, { tone: string; icon: string; label: string }> = {};
    for (const m of block!.matchAll(
      /"?([a-z-]+)"?:\s*\{\s*label:\s*"([^"]+)",\s*tone:\s*"([^"]+)",\s*icon:\s*"([^"]+)"/g,
    )) {
      out[m[1]!] = { label: m[2]!, tone: m[3]!, icon: m[4]! };
    }
    return out;
  }

  it("covers exactly the six statuses deriveStatus can return", () => {
    const declared = [
      ...source.matchAll(/return "([a-z-]+)";/g),
    ].map((m) => m[1]!);
    const table = entries();
    expect(Object.keys(table).sort()).toEqual(
      ["failed", "filling", "needs-you", "queued", "ready", "submitted"].sort(),
    );
    for (const status of declared) {
      expect(table[status], `deriveStatus returns "${status}", which is presented`)
        .toBeTruthy();
    }
  });

  it("'needs you' and 'failed' are not the same colour", () => {
    // The regression this test exists for: both were "danger" before, so a
    // question the operator can answer looked identical to a crash.
    const table = entries();
    expect(table["needs-you"]!.tone).toBe("warn");
    expect(table["failed"]!.tone).toBe("danger");
    expect(table["needs-you"]!.tone).not.toBe(table["failed"]!.tone);
  });

  it("each status is identifiable by its icon alone", () => {
    // Colour carries urgency (grey/blue/green/amber/red) and repeats by
    // design; the icon is what makes two same-coloured statuses distinct.
    const icons = Object.values(entries()).map((e) => e.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it("no surface derives its own status vocabulary", () => {
    const offenders = walk(SRC)
      .filter((f) => f !== STATUS_PATH)
      .filter((f) => /CHIP_CLASS|deriveChip|AutomationChip/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(SRC, f));
    expect(offenders, "import deriveStatus/StatusChip instead").toEqual([]);
  });
});
