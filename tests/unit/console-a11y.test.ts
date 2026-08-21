import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * DESIGN.md §5 makes four accessibility claims. Three of them were
 * false when written: there was no skip link, the app carried two aria
 * attributes in total, and no landmark was labelled. Claims a project
 * makes about itself should be executable, so these are.
 *
 * Text-level, like the other frontend contracts here — frontend/ is a
 * separate TS project the backend tsconfig cannot compile.
 * UNIT_CONFIRMED.
 */

const SRC = path.join(process.cwd(), "frontend", "src");
const APP = fs.readFileSync(path.join(SRC, "App.tsx"), "utf8");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.tsx$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("console accessibility contract (UNIT_CONFIRMED)", () => {
  it("a keyboard can skip the navigation", () => {
    expect(APP).toMatch(/className="skip-link"\s+href="#main"/);
    expect(APP).toMatch(/<main[^>]*id="main"/);
    const base = fs.readFileSync(path.join(SRC, "styles", "base.css"), "utf8");
    // Off-screen until focused, on-screen when focused: both halves are
    // required — one without the other is either invisible or always visible.
    expect(base).toMatch(/\.skip-link\s*\{[^}]*left:\s*-9999px/);
    expect(base).toMatch(/\.skip-link:focus\s*\{[^}]*left:/);
  });

  it("the primary navigation is a labelled landmark", () => {
    expect(APP).toMatch(/<nav aria-label="Primary">/);
  });

  it("every interactive element has a visible focus state", () => {
    const base = fs.readFileSync(path.join(SRC, "styles", "base.css"), "utf8");
    expect(base).toMatch(/:focus-visible\s*\{[^}]*outline:/);
  });

  it("no icon is a control's only content without a label", () => {
    // Icon.tsx is aria-hidden by default because icons here accompany
    // text. A control whose whole label is an icon must pass `label`.
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.matchAll(
        /<button(?![^>]*aria-label)[^>]*>\s*(<Icon\b[^>]*\/>)\s*<\/button>/g,
      )) {
        if (!/\blabel=/.test(m[1]!)) {
          offenders.push(path.relative(SRC, file));
        }
      }
    }
    expect(offenders, "give the button an aria-label or the Icon a label").toEqual(
      [],
    );
  });

  it("color is never the only signal — every status chip carries a word", () => {
    const status = fs.readFileSync(path.join(SRC, "lib", "appStatus.ts"), "utf8");
    const labels = [...status.matchAll(/label:\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(labels.length).toBeGreaterThanOrEqual(6);
    for (const label of labels) expect(label.trim().length).toBeGreaterThan(0);
  });
});
