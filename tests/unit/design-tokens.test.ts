import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * design/tokens.json is the machine-readable mirror of the CSS custom
 * properties in frontend/src/styles/tokens.css (which the running UI
 * consumes and which stays authoritative). A design schema that can drift
 * from the shipped UI is decoration — this test makes the mirror a
 * contract. UNIT_CONFIRMED.
 *
 * LIGHT is the default theme, so it lives in :root; dark is applied by the
 * OS preference and by the explicit toggle, which means the dark palette
 * is necessarily written twice (CSS cannot share a declaration block
 * across a media boundary). The two copies are asserted identical here so
 * that duplication can never become drift.
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

function blockAfter(css: string, selectorPattern: RegExp): string {
  const m = css.match(selectorPattern);
  expect(m, `block ${selectorPattern} present in tokens.css`).toBeTruthy();
  return m![1]!;
}

/**
 * :root carries the default (light) palette plus every non-color scale;
 * the dark palette appears in both the media query and the explicit
 * toggle block.
 */
function readCssPalettes(): {
  light: Record<string, string>;
  dark: Record<string, string>;
  darkMedia: Record<string, string>;
} {
  const css = fs.readFileSync(CSS_PATH, "utf8");
  return {
    light: parseVars(blockAfter(css, /:root\s*\{([\s\S]*?)\}/)),
    dark: parseVars(blockAfter(css, /:root\[data-theme="dark"\]\s*\{([\s\S]*?)\}/)),
    darkMedia: parseVars(
      blockAfter(css, /:root:not\(\[data-theme="light"\]\)\s*\{([\s\S]*?)\}/),
    ),
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
    for (const theme of ["light", "dark"] as const) {
      const cssColorNames = Object.keys(css[theme]).filter(
        (n) => /^#|rgba?\(/.test(css[theme][n]!) && !n.endsWith("-dim"),
      );
      for (const name of cssColorNames) {
        // -dim companions are derived (alpha of the base) and shadows are
        // depth documented in their own group — everything else must be in
        // the color schema.
        if (name.startsWith("shadow")) continue;
        expect(
          documented.has(name),
          `--${name} (${theme}) documented in tokens.json`,
        ).toBe(true);
      }
    }
  });

  it("the two dark-palette copies are identical — duplication cannot become drift", () => {
    expect(css.darkMedia).toEqual(css.dark);
  });

  it("fonts, radii, layout, and shadows match", () => {
    expect(css.light["font-mono"]).toBe(leaf(json, "font", "mono").$value);
    expect(css.light["font-ui"]).toBe(leaf(json, "font", "ui").$value);
    expect(css.light["radius"]).toBe(leaf(json, "radius", "default").$value);
    expect(css.light["radius-sm"]).toBe(leaf(json, "radius", "sm").$value);
    expect(css.light["radius-lg"]).toBe(leaf(json, "radius", "lg").$value);
    expect(css.light["sidebar-w"]).toBe(leaf(json, "layout", "sidebar-width").$value);
    for (const theme of ["light", "dark"] as const) {
      expect(css[theme]["shadow-sm"]).toBe(leaf(json, "shadow", theme, "sm").$value);
      expect(css[theme]["shadow"]).toBe(leaf(json, "shadow", theme, "default").$value);
    }
  });

  it("the type scale is mirrored, and it is the only set of sizes", () => {
    const type = leaf(json, "type") as unknown as Record<string, TokenLeaf>;
    const names = Object.keys(type).filter((k) => !k.startsWith("$"));
    expect(names.length).toBeGreaterThanOrEqual(7);
    for (const name of names) {
      expect(css.light[`text-${name}`], `--text-${name} in tokens.css`).toBe(
        type[name]!.$value,
      );
    }
  });

  it("the spacing scale, motion tokens, and z-layers are mirrored", () => {
    const space = leaf(json, "space") as unknown as Record<string, TokenLeaf>;
    for (const name of Object.keys(space).filter((k) => !k.startsWith("$"))) {
      expect(css.light[`space-${name}`], `--space-${name}`).toBe(
        space[name]!.$value,
      );
    }
    expect(css.light["duration-fast"]).toBe(
      leaf(json, "motion", "duration-fast").$value,
    );
    expect(css.light["duration-base"]).toBe(
      leaf(json, "motion", "duration-base").$value,
    );
    expect(css.light["ease-out"]).toBe(leaf(json, "motion", "ease-out").$value);
    const layer = leaf(json, "layer") as unknown as Record<string, TokenLeaf>;
    for (const name of Object.keys(layer).filter((k) => !k.startsWith("$"))) {
      expect(css.light[`z-${name}`], `--z-${name}`).toBe(layer[name]!.$value);
    }
  });

  it("brand assets use palette colors only (favicon + every design/*.svg)", () => {
    const designDir = path.join(process.cwd(), "design");
    const assets = [
      path.join(process.cwd(), "frontend", "public", "favicon.svg"),
      ...fs
        .readdirSync(designDir)
        .filter((f) => f.endsWith(".svg"))
        .map((f) => path.join(designDir, f)),
    ];
    expect(assets.length).toBeGreaterThanOrEqual(2);
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

  it("the marketing site's palette matches the console's — one system, two surfaces", () => {
    // site/dispatch.css re-declares the palette as literal hexes because it
    // ships with no build step. Nothing guarded that until now, which made
    // it the one place a palette change could silently diverge.
    const sitePath = path.join(process.cwd(), "site", "dispatch.css");
    const site = fs.readFileSync(sitePath, "utf8");
    const siteDark = parseVars(blockAfter(site, /:root\s*\{([\s\S]*?)\}/));
    const palette = new Set(
      [...Object.values(css.dark), ...Object.values(css.light)].map((v) =>
        v.toLowerCase().replace(/\s+/g, " "),
      ),
    );
    for (const [name, value] of Object.entries(siteDark)) {
      if (!/^#|rgba?\(/.test(value)) continue;
      expect(
        palette.has(value.toLowerCase().replace(/\s+/g, " ")),
        `site/dispatch.css --${name}: ${value} is a console palette color`,
      ).toBe(true);
    }
  });
});
