import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigCache } from "../../src/config/index.js";
import {
  loadPersona,
  PersonaPlaceholderError,
} from "../../src/candidate/personas.js";

/**
 * A persona copied from default.example.json without being filled in must
 * refuse to generate — the live 2026-08-18 incident produced a VALIDATED
 * draft whose bullets literally said "REPLACE_PROJECT_ONE". UNIT_CONFIRMED.
 */
describe("persona placeholder guard (UNIT_CONFIRMED)", () => {
  let privateDir: string;
  let savedPrivateDir: string | undefined;

  const writePersona = (projects: Array<{ name: string }>) => {
    const dir = path.join(privateDir, "candidate", "personas");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "default.json"),
      JSON.stringify({
        persona_id: "default",
        headline: "Sophomore at Johns Hopkins",
        education: {
          school: "Johns Hopkins University",
          class_year: 2029,
          majors: ["Applied Mathematics & Statistics"],
        },
        projects: projects.map((p) => ({
          name: p.name,
          summary: "A summary.",
          tools: ["TypeScript"],
          relevance_tags: ["infra"],
        })),
      }),
    );
  };

  beforeEach(() => {
    privateDir = path.join(os.tmpdir(), `jaa-persona-${randomUUID()}`);
    savedPrivateDir = process.env.PRIVATE_DIR;
    process.env.PRIVATE_DIR = privateDir;
    resetConfigCache();
  });

  afterEach(() => {
    if (savedPrivateDir === undefined) delete process.env.PRIVATE_DIR;
    else process.env.PRIVATE_DIR = savedPrivateDir;
    resetConfigCache();
    fs.rmSync(privateDir, { recursive: true, force: true });
  });

  it("refuses a persona still carrying example REPLACE_* projects, naming them", () => {
    writePersona([
      { name: "REPLACE_PROJECT_ONE" },
      { name: "Real Actual Project" },
    ]);
    expect(() => loadPersona("default")).toThrow(PersonaPlaceholderError);
    expect(() => loadPersona("default")).toThrow(/REPLACE_PROJECT_ONE/);
    expect(() => loadPersona("default")).toThrow(/replace them with your real projects/);
  });

  it("accepts a persona with real project names", () => {
    writePersona([{ name: "Dispatch Application Pipeline" }]);
    const persona = loadPersona("default");
    expect(persona.projects[0]?.name).toBe("Dispatch Application Pipeline");
  });
});
