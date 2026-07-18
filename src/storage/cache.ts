import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { writeJsonAtomic, readJsonFile } from "./atomicJson.js";

export type CacheEntry<T> = {
  fetched_at: string;
  data: T;
};

export function cacheFilePath(
  cacheDir: string,
  namespace: string,
  key: string,
): string {
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 8);
  const slug = key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return path.join(cacheDir, namespace, `${slug}-${hash}.json`);
}

export function readCache<T>(
  cacheDir: string,
  namespace: string,
  key: string,
  ttlMs: number,
): T | undefined {
  if (process.env.FORCE_REFRESH === "1") {
    return undefined;
  }
  const file = cacheFilePath(cacheDir, namespace, key);
  if (!fs.existsSync(file)) return undefined;
  const entry = readJsonFile<CacheEntry<T>>(file);
  const age = Date.now() - Date.parse(entry.fetched_at);
  if (Number.isNaN(age) || age > ttlMs) return undefined;
  return entry.data;
}

export function writeCache<T>(
  cacheDir: string,
  namespace: string,
  key: string,
  data: T,
): void {
  const file = cacheFilePath(cacheDir, namespace, key);
  writeJsonAtomic(file, {
    fetched_at: new Date().toISOString(),
    data,
  } satisfies CacheEntry<T>);
}
