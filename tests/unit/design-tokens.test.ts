import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * design/tokens.json is the machine-readable mirror of the CSS custom
 * properties in frontend/src/styles/tokens.css (which the running UI
 * consumes and which stays authoritative). A design schema that can drift
 * from the shipped UI is decoration — this test makes the mirror a
 * contract. UNIT_CONFIRMED.
 */

const CSS_PATH = path.join(process.cwd(), "frontend", "src", "styles", "tokens.css");
const JSON_PATH = path.join(process.cwd(), "design", "tokens.json");

type TokenLeaf = { $type: string; $value: string | string[] };
type TokenGroup = { [key: string]: TokenLeaf | TokenGroup | string };

function parseVars(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/gi)) {
    out[m[1]!] = m[2]!.replace(/\s+/g, " ").trim();
  }
  return out;
}

/** The :root dark palette and the explicit light override block. */
function readCssPalettes(): { dark: Record<string, string>; light: Record<string, string> } {
  const css = fs.readFileSync(CSS_PATH, "utf8");
  const rootMatch = css.match(/:root\s*\{([\s\S]*?)\}/);
  const lightMatch = css.match(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\}/);
  expect(rootMatch, ":root block present in tokens.css").toBeTruthy();
  expect(lightMatch, 'explicit [data-theme="light"] block present').toBeTruthy();
  return {
    dark: parseVars(rootMatch![1]!),
    light: parseVars(lightMatch![1]!),
  };
}

function readJsonTokens(): TokenGroup {
  return JSON.parse(fs.readFileSync(JSON_PATH, "utf8")) as TokenGroup;
}

function leaf(group: TokenGroup, ...keys: string[]): TokenLeaf {
  let cur: TokenLeaf | TokenGroup | string = group;
  for (const k of keys) {
    expect(typeof cur, `group at ${keys.join(".")}`).toBe("object");
    cur = (cur as TokenGroup)[k]!;
    expect(cur, `token ${keys.join(".")}`).toBeTruthy();
  }
  return cur as TokenLeaf;
}

describe("design/tokens.json ↔ tokens.css contract (UNIT_CONFIRMED)", () => {
  const css = readCssPalettes();
  const json = readJsonTokens();

  it("every color token in the schema matches the CSS palette, both themes", () => {
    const colors = leaf(json, "color") as unknown as {
      dark: Record<string, TokenLeaf>;
      light: Record<string, TokenLeaf>;
    };
    for (const theme of ["dark", "light"] as const) {
      for (const [name, token] of Object.entries(colors[theme])) {
        expect(
          css[theme][name],
          `--${name} exists in the CSS ${theme} palette`,
        ).toBeDefined();
        expect(
          css[theme][name]!.toLowerCase(),
          `--${name} (${theme})`,
        ).toBe((token.$value as string).toLowerCase());
      }
    }
  });

  it("the CSS palettes carry no color the schema doesn't document", () => {
    const colors = leaf(json, "color") as unknown as {
      dark: Record<string, TokenLeaf>;
    };
    const documented = new Set(Object.keys(colors.dark));
    const cssColorNames = Object.keys(css.dark).filter(
      (n) => /^#|rgba?\(/.test(css.dark[n]!) && !n.endsWith("-dim"),
    );
    for (const name of cssColorNames) {
      // -dim companions are derived (alpha of the base) and shadow is depth,
      // not palette — everything else must be documented in the schema.
      if (name === "shadow") continue;
      expect(documented.has(name), `--${name} documented in tokens.json`).toBe(true);
    }
  });

  it("fonts, radii, and sidebar width match", () => {
    expect(css.dark["font-mono"]).toBe(leaf(json, "font", "mono").$value);
    expect(css.dark["font-ui"]).toBe(leaf(json, "font", "ui").$value);
    expect(css.dark["radius"]).toBe(leaf(json, "radius", "default").$value);
    expect(css.dark["radius-sm"]).toBe(leaf(json, "radius", "sm").$value);
    expect(css.dark["sidebar-w"]).toBe(leaf(json, "layout", "sidebar-width").$value);
  });

  it("brand assets use palette colors only (favicon + lockup)", () => {
    const assets = [
      path.join(process.cwd(), "frontend", "public", "favicon.svg"),
      path.join(process.cwd(), "design", "logo.svg"),
    ];
    const palette = new Set(
      [...Object.values(css.dark), ...Object.values(css.light)].map((v) =>
        v.toLowerCase(),
      ),
    );
    for (const asset of assets) {
      const svg = fs.readFileSync(asset, "utf8");
      for (const m of svg.matchAll(/#[0-9a-f]{6}\b/gi)) {
        expect(
          palette.has(m[0]!.toLowerCase()),
          `${path.basename(asset)} color ${m[0]} is a palette color`,
        ).toBe(true);
      }
    }
  });
});
