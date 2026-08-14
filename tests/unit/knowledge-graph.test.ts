import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The knowledge graph (docs/knowledge-graph/graph.json) is only useful if
 * it is TRUE. This test makes every claim in it checkable: files exist,
 * exported symbols exist, edges reference known nodes, every top-level
 * src/ directory is owned by exactly one node, and every flag it lists is
 * a real env key. Add a subsystem or rename an export and the gate fails
 * until the graph is updated — the graph cannot rot.
 */

type GraphNode = {
  id: string;
  label: string;
  layer: string;
  purpose: string;
  paths: string[];
  key_files: Record<string, string>;
  key_exports?: Record<string, string[]>;
  gates?: string[];
};

type GraphEdge = {
  from: string;
  to: string;
  kind: string;
  why: string;
  external?: boolean;
};

type Graph = {
  version: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  flags: Record<string, string>;
  invariants: string[];
};

const ROOT = path.resolve(__dirname, "..", "..");
const graph = JSON.parse(
  fs.readFileSync(path.join(ROOT, "docs", "knowledge-graph", "graph.json"), "utf8"),
) as Graph;

describe("knowledge graph is true (UNIT_CONFIRMED)", () => {
  const nodeIds = new Set(graph.nodes.map((n) => n.id));

  it("has unique node ids", () => {
    expect(nodeIds.size).toBe(graph.nodes.length);
  });

  it("every path and key_file exists on disk", () => {
    const missing: string[] = [];
    for (const node of graph.nodes) {
      for (const p of node.paths) {
        if (!fs.existsSync(path.join(ROOT, p))) missing.push(`${node.id}: ${p}`);
      }
      for (const f of Object.keys(node.key_files)) {
        if (!fs.existsSync(path.join(ROOT, f))) missing.push(`${node.id}: ${f}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("every key_export actually exists in its file", () => {
    const missing: string[] = [];
    for (const node of graph.nodes) {
      for (const [file, names] of Object.entries(node.key_exports ?? {})) {
        const full = path.join(ROOT, file);
        if (!fs.existsSync(full)) {
          missing.push(`${node.id}: ${file} (file missing)`);
          continue;
        }
        const src = fs.readFileSync(full, "utf8");
        for (const name of names) {
          // Direct export (function/class/const/type/interface) or a
          // re-export block containing the name.
          const direct = new RegExp(
            `export\\s+(?:async\\s+)?(?:function|class|const|let|type|interface|enum)\\s+${name}\\b`,
          );
          const block = new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`, "s");
          if (!direct.test(src) && !block.test(src)) {
            missing.push(`${node.id}: ${file} does not export ${name}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("every top-level src/ directory is owned by exactly ONE node", () => {
    const dirs = fs
      .readdirSync(path.join(ROOT, "src"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => `src/${d.name}`);
    const problems: string[] = [];
    for (const dir of dirs) {
      const owners = graph.nodes.filter((n) =>
        n.paths.some((p) => p === dir || p.startsWith(`${dir}/`)),
      );
      if (owners.length === 0) {
        problems.push(`${dir} is not covered by any node — add it to the graph`);
      } else if (owners.length > 1) {
        problems.push(
          `${dir} owned by multiple nodes: ${owners.map((o) => o.id).join(", ")}`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it("every edge references known nodes (unless marked external)", () => {
    const bad = graph.edges.filter(
      (e) => !e.external && (!nodeIds.has(e.from) || !nodeIds.has(e.to)),
    );
    expect(bad.map((e) => `${e.from} -> ${e.to}`)).toEqual([]);
  });

  it("every node participates in at least one edge", () => {
    const connected = new Set<string>();
    for (const e of graph.edges) {
      connected.add(e.from);
      connected.add(e.to);
    }
    const orphans = graph.nodes
      .map((n) => n.id)
      .filter((id) => !connected.has(id))
      // foundation nodes may be pure dependencies referenced by prose
      .filter((id) => !["logging", "jobs"].includes(id));
    expect(orphans).toEqual([]);
  });

  it("every flag in the registry (and every node gate) is a real env key", () => {
    const envSrc = fs.readFileSync(path.join(ROOT, "src", "config", "env.ts"), "utf8");
    const missing: string[] = [];
    for (const flag of Object.keys(graph.flags)) {
      if (flag.startsWith("$")) continue; // JSON commentary keys
      if (!envSrc.includes(flag)) missing.push(`flags: ${flag} not in env.ts`);
    }
    for (const node of graph.nodes) {
      for (const gate of node.gates ?? []) {
        if (!(gate in graph.flags)) {
          missing.push(`${node.id}: gate ${gate} not in the flag registry`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("retired flags do not linger in the registry", () => {
    // GENERIC_ATS_ENABLED was removed 2026-08-14 (operator directive).
    expect(Object.keys(graph.flags)).not.toContain("GENERIC_ATS_ENABLED");
  });

  it("the README companion exists and points at the validator", () => {
    const readme = fs.readFileSync(
      path.join(ROOT, "docs", "knowledge-graph", "README.md"),
      "utf8",
    );
    expect(readme).toMatch(/graph\.json/);
    expect(readme).toMatch(/knowledge-graph\.test\.ts/);
  });
});
