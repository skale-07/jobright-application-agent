import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config/index.js";

export function writeJsonAtomic(
  filePath: string,
  data: unknown,
  spaces = 2,
): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, spaces)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

export function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

export function applicationArtifactDir(applicationId: string): string {
  return path.join(getConfig().artifactsDir, "applications", applicationId);
}

export function ensureApplicationArtifactDirs(applicationId: string): {
  root: string;
  screenshots: string;
  traces: string;
  errors: string;
  linkedin: string;
  emails: string;
  drafts: string;
} {
  const root = applicationArtifactDir(applicationId);
  const dirs = {
    root,
    screenshots: path.join(root, "screenshots"),
    traces: path.join(root, "traces"),
    errors: path.join(root, "errors"),
    linkedin: path.join(root, "linkedin"),
    emails: path.join(root, "emails"),
    drafts: path.join(root, "drafts"),
  };
  for (const d of Object.values(dirs)) {
    fs.mkdirSync(d, { recursive: true });
  }
  return dirs;
}

export function humanQueuePaths(applicationId: string): {
  json: string;
  md: string;
} {
  const base = path.join(getConfig().artifactsDir, "human-queue");
  fs.mkdirSync(base, { recursive: true });
  return {
    json: path.join(base, `${applicationId}.json`),
    md: path.join(base, `${applicationId}.md`),
  };
}
