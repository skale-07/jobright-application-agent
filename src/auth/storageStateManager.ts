import fs from "node:fs";
import path from "node:path";

export function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function storageStateExists(storageStatePath: string): boolean {
  return fs.existsSync(storageStatePath);
}

export function requireStorageState(storageStatePath: string): void {
  if (!storageStateExists(storageStatePath)) {
    throw new Error(
      `Missing storage state at ${storageStatePath}. Run the matching npm run login:* command first.`,
    );
  }
}

export function assertLooksLikeStorageState(filePath: string): void {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as { cookies?: unknown; origins?: unknown };
  if (!Array.isArray(parsed.cookies)) {
    throw new Error(`Invalid Playwright storageState (missing cookies[]): ${filePath}`);
  }
  if (!Array.isArray(parsed.origins)) {
    throw new Error(`Invalid Playwright storageState (missing origins[]): ${filePath}`);
  }
}

export function writeStorageStateFile(filePath: string, state: unknown): void {
  ensureParentDir(filePath);
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}
