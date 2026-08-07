import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getConfig } from "../config/index.js";

/**
 * Personas are the initial data layer for outreach generation: the facts the
 * model is allowed to draw technical-alignment bullets from. Nothing outside
 * a persona may appear as a project claim in a generated email — the
 * deterministic validator enforces this after generation.
 *
 * Live files: private/candidate/personas/<id>.json (gitignored).
 * Committed:  private/candidate/personas/default.example.json only.
 */
export const personaProjectSchema = z.object({
  name: z.string().min(1),
  summary: z.string().min(1),
  tools: z.array(z.string()).default([]),
  /** Match hints against contact/job context, e.g. ["ml", "infra", "fintech"]. */
  relevance_tags: z.array(z.string()).default([]),
});

export const personaSchema = z.object({
  persona_id: z.string().min(1),
  headline: z.string().min(1),
  education: z.object({
    school: z.string().min(1),
    class_year: z.number().int(),
    majors: z.array(z.string()).min(1),
  }),
  projects: z.array(personaProjectSchema).min(1),
  skills: z.array(z.string()).default([]),
  interests: z.array(z.string()).default([]),
});

export type Persona = z.infer<typeof personaSchema>;
export type PersonaProject = z.infer<typeof personaProjectSchema>;

export function personasDir(): string {
  return path.join(getConfig().privateDir, "candidate", "personas");
}

export class PersonaNotFoundError extends Error {
  constructor(id: string, dir: string) {
    super(
      `Persona "${id}" not found at ${path.join(dir, `${id}.json`)}. ` +
        `Copy default.example.json to <id>.json and fill in real projects.`,
    );
    this.name = "PersonaNotFoundError";
  }
}

export function loadPersona(id = "default"): Persona {
  const dir = personasDir();
  const file = path.join(dir, `${id}.json`);
  if (!fs.existsSync(file)) {
    throw new PersonaNotFoundError(id, dir);
  }
  const parsed = personaSchema.safeParse(
    JSON.parse(fs.readFileSync(file, "utf8")),
  );
  if (!parsed.success) {
    throw new Error(
      `Persona "${id}" failed validation: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

export function listPersonas(): string[] {
  const dir = personasDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".example.json"))
    .map((f) => f.replace(/\.json$/, ""));
}
