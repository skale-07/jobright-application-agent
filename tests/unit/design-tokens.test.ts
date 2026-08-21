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
    expect(css.light["breakpoint-compact"]).toBe(
      leaf(json, "layout", "breakpoint-compact").$value,
    );
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

  it("the compact layout exists and fires at the documented breakpoint", () => {
    // DESIGN.md §5 promised since the brand work that the sidebar
    // collapses to a top bar below ~960px. Nothing implemented it, and
    // nothing caught that the documentation was false. A media query
    // cannot read a custom property, so the literal in base.css is
    // checked against the token instead.
    const base = fs.readFileSync(
      path.join(process.cwd(), "frontend", "src", "styles", "base.css"),
      "utf8",
    );
    const breakpoint = css.light["breakpoint-compact"]!;
    expect(base).toMatch(
      new RegExp(`@media\\s*\\(max-width:\\s*${breakpoint}\\)`),
    );
    // The rule has to actually restack the shell, not merely exist.
    const block = base.match(
      new RegExp(`@media\\s*\\(max-width:\\s*${breakpoint}\\)\\s*\\{([\\s\\S]*?)\\n\\}`),
    )?.[1];
    expect(block, "compact block body").toBeTruthy();
    expect(block).toMatch(/\.shell\s*\{[^}]*flex-direction:\s*column/);
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

  it("the marketing site runs the console's system exactly — one system, two surfaces", () => {
    // site/dispatch.css re-declares everything as literals because it ships
    // with no build step, so the mirror is a contract rather than a
    // convention: both palettes and every shared scale must agree
    // value-for-value with tokens.css.
    const site = fs.readFileSync(
      path.join(process.cwd(), "site", "dispatch.css"),
      "utf8",
    );
    const siteLight = parseVars(blockAfter(site, /:root\s*\{([\s\S]*?)\}/));
    const siteDark = parseVars(
      blockAfter(site, /:root\[data-theme="dark"\]\s*\{([\s\S]*?)\}/),
    );
    const siteDarkMedia = parseVars(
      blockAfter(site, /:root:not\(\[data-theme="light"\]\)\s*\{([\s\S]*?)\}/),
    );
    expect(siteDarkMedia, "the site's two dark copies are identical").toEqual(
      siteDark,
    );

    for (const [theme, siteVars] of [
      ["light", siteLight],
      ["dark", siteDark],
    ] as const) {
      for (const [name, value] of Object.entries(siteVars)) {
        const consoleValue = css[theme][name];
        if (consoleValue === undefined) continue; // site-only layout var
        expect(
          value.toLowerCase().replace(/\s+/g, " "),
          `site/dispatch.css --${name} (${theme}) matches tokens.css`,
        ).toBe(consoleValue.toLowerCase().replace(/\s+/g, " "));
      }
    }

    // The site must not invent a font size outside the shared scale — the
    // exact drift that made the console's own scale documentation false.
    const sizes = [...site.matchAll(/font-size:\s*([^;]+);/g)].map((m) =>
      m[1]!.trim(),
    );
    const strays = sizes.filter(
      (v) =>
        !v.startsWith("var(--text-") &&
        // The rem anchor on <body>, the fluid hero, and SVG drawing units
        // are layout decisions, not scale steps.
        !["16px", "12px", "10px"].includes(v) &&
        !v.startsWith("clamp("),
    );
    expect(strays, "site font sizes come from the shared type scale").toEqual([]);
  });

  it("the read-only dashboard carries the palette too — no unbranded surface", () => {
    // src/dashboard/server.ts ships its page as a string inside the server
    // and cannot import tokens.css, so it writes the palette out literally.
    const server = fs.readFileSync(
      path.join(process.cwd(), "src", "dashboard", "server.ts"),
      "utf8",
    );
    const html = server.slice(
      server.indexOf("const INDEX_HTML"),
      server.indexOf("</html>`;"),
    );
    expect(html).toContain("prefers-color-scheme: dark");
    const palette = new Set(
      [...Object.values(css.dark), ...Object.values(css.light)].map((v) =>
        v.toLowerCase(),
      ),
    );
    const hexes = [...html.matchAll(/#[0-9a-f]{6}\b/gi)].map((m) => m[0]!);
    expect(hexes.length).toBeGreaterThanOrEqual(8);
    for (const hex of hexes) {
      expect(
        palette.has(hex.toLowerCase()),
        `dashboard color ${hex} is a palette color`,
      ).toBe(true);
    }
  });
});
