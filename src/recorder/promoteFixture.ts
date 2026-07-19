import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Db } from "../storage/db/client.js";
import { writeJsonAtomic } from "../storage/atomicJson.js";
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  failIdempotencyKey,
} from "../queue/idempotency.js";
import { scanTextForSecrets } from "../security/artifactScan.js";
import {
  CAPTURE_FILES,
  captureRunDir,
  derivedFixtureDir,
  liveCapturesRoot,
  parseWorkflow,
  type JobRightWorkflow,
} from "./workflows.js";

/** Files copied from a sanitized live capture into committed fixtures. */
export const PROMOTE_COPY_FILES = [
  CAPTURE_FILES.url,
  CAPTURE_FILES.dom,
  CAPTURE_FILES.a11y,
  CAPTURE_FILES.labels,
  CAPTURE_FILES.iframes,
  CAPTURE_FILES.network,
  CAPTURE_FILES.pages,
  CAPTURE_FILES.downloads,
  CAPTURE_FILES.routeLog,
  CAPTURE_FILES.meta,
] as const;

export const PROMOTE_EXCLUDE_FILES = [CAPTURE_FILES.screenshot] as const;

export type PromoteFixtureOptions = {
  runId: string;
  workflow: JobRightWorkflow | string;
  /** Overwrite existing derived fixture files. Default false. */
  force?: boolean;
  liveCapturesRoot?: string;
  fixturesRoot?: string;
  db?: Db;
  holderRunId?: string;
};

export type PromoteFixtureResult = {
  status: "promoted" | "skipped" | "failed";
  workflow: JobRightWorkflow;
  runId: string;
  sourceDir: string;
  outDir: string;
  copied: string[];
  idempotency_key: string;
  evidence: string;
};

export function promoteIdempotencyKey(
  workflow: JobRightWorkflow,
  runId: string,
): string {
  return `promote:${workflow}:${runId}`;
}

function assertSanitizedLiveCapturePath(
  sourceDir: string,
  workflow: JobRightWorkflow,
  runId: string,
  capturesRoot: string,
): void {
  const expected = path.resolve(captureRunDir(workflow, runId, capturesRoot));
  const resolved = path.resolve(sourceDir);
  if (resolved !== expected) {
    throw new Error(
      `Capture path mismatch: expected ${expected}, got ${resolved}`,
    );
  }

  const norm = resolved.replace(/\\/g, "/").toLowerCase();
  if (norm.includes("/raw-captures/") || norm.includes("/raw/")) {
    throw new Error("Refusing to promote from raw captures path");
  }
  if (!norm.includes("/live-captures/")) {
    throw new Error(
      "Promotion only allowed from fixtures/live-captures (sanitized live captures)",
    );
  }

  const dom = path.join(resolved, CAPTURE_FILES.dom);
  if (!fs.existsSync(dom)) {
    throw new Error(
      `Missing sanitized DOM (${CAPTURE_FILES.dom}) — refuse raw/incomplete capture`,
    );
  }

  // Reject obvious raw dump filenames in the capture dir
  const entries = fs.readdirSync(resolved);
  for (const name of entries) {
    if (/^dom(\.raw)?\.html$/i.test(name) && name !== CAPTURE_FILES.dom) {
      throw new Error(`Raw DOM file present (${name}) — sanitize before promote`);
    }
    if (/^network\.json$/i.test(name) && name !== CAPTURE_FILES.network) {
      throw new Error(
        `Raw network file present (${name}) — sanitize before promote`,
      );
    }
  }
}

function scanCaptureForSecrets(sourceDir: string): void {
  const textFiles = [
    CAPTURE_FILES.dom,
    CAPTURE_FILES.a11y,
    CAPTURE_FILES.labels,
    CAPTURE_FILES.iframes,
    CAPTURE_FILES.network,
    CAPTURE_FILES.pages,
    CAPTURE_FILES.downloads,
    CAPTURE_FILES.routeLog,
    CAPTURE_FILES.url,
    CAPTURE_FILES.meta,
  ];
  const hits: string[] = [];
  for (const name of textFiles) {
    const full = path.join(sourceDir, name);
    if (!fs.existsSync(full)) continue;
    const text = fs.readFileSync(full, "utf8");
    const found = scanTextForSecrets(text);
    if (found.length > 0) {
      hits.push(`${name}: ${found.join(", ")}`);
    }
  }
  if (hits.length > 0) {
    throw new Error(
      `Secret/PII scan failed before promote:\n  - ${hits.join("\n  - ")}`,
    );
  }
}

/**
 * Promote a sanitized live-capture run into tests/fixtures/jobright/{workflow}/.
 *
 * - Only from fixtures/live-captures/{workflow}/{runId}
 * - Rejects raw captures
 * - Secret/PII scan before copy
 * - Refuses overwrite unless force
 * - Excludes screenshots
 * - Writes provenance meta
 * - Idempotent via promote:{workflow}:{runId} when db provided
 */
export function promoteFixture(
  options: PromoteFixtureOptions,
): PromoteFixtureResult {
  const workflow = parseWorkflow(
    typeof options.workflow === "string"
      ? options.workflow
      : options.workflow,
  );
  const runId = options.runId;
  const capturesRoot = options.liveCapturesRoot ?? liveCapturesRoot();
  const sourceDir = captureRunDir(workflow, runId, capturesRoot);
  const outDir = derivedFixtureDir(workflow, options.fixturesRoot);
  const key = promoteIdempotencyKey(workflow, runId);
  const force = Boolean(options.force);

  const baseResult = {
    workflow,
    runId,
    sourceDir,
    outDir,
    idempotency_key: key,
  };

  if (!fs.existsSync(sourceDir)) {
    return {
      ...baseResult,
      status: "failed",
      copied: [],
      evidence: `Capture directory not found: ${sourceDir}`,
    };
  }

  try {
    assertSanitizedLiveCapturePath(sourceDir, workflow, runId, capturesRoot);
    scanCaptureForSecrets(sourceDir);

    if (options.db) {
      const claim = claimIdempotencyKey(options.db, key, {
        holderRunId: options.holderRunId ?? `promote-${randomUUID()}`,
        resourceType: "fixture_promote",
        resourceId: `${workflow}/${runId}`,
      });
      if (claim.action === "skip") {
        return {
          ...baseResult,
          status: "skipped",
          copied: [],
          evidence: "Idempotency key already completed — skipped promote",
        };
      }
    }

    fs.mkdirSync(outDir, { recursive: true });

    if (!force) {
      const existing: string[] = [];
      for (const name of PROMOTE_COPY_FILES) {
        const committed =
          name === CAPTURE_FILES.dom
            ? "dom.sanitized.html"
            : name === CAPTURE_FILES.a11y
              ? "a11y.sanitized.yml"
              : name;
        if (fs.existsSync(path.join(outDir, committed))) {
          existing.push(committed);
        }
      }
      const contentExisting = existing.filter(
        (n) =>
          n !== CAPTURE_FILES.meta &&
          n !== "source-meta.json" &&
          n !== "promote-meta.json",
      );
      if (contentExisting.length > 0) {
        if (options.db) {
          failIdempotencyKey(
            options.db,
            key,
            `Refuse overwrite: ${contentExisting.join(", ")}`,
          );
        }
        return {
          ...baseResult,
          status: "failed",
          copied: [],
          evidence: `Refuse overwrite (pass --force): ${contentExisting.join(", ")}`,
        };
      }
    }

    const copied: string[] = [];
    for (const name of PROMOTE_COPY_FILES) {
      if ((PROMOTE_EXCLUDE_FILES as readonly string[]).includes(name)) continue;
      const src = path.join(sourceDir, name);
      if (!fs.existsSync(src)) continue;
      const committed =
        name === CAPTURE_FILES.dom
          ? "dom.sanitized.html"
          : name === CAPTURE_FILES.a11y
            ? "a11y.sanitized.yml"
            : name;
      fs.copyFileSync(src, path.join(outDir, committed));
      copied.push(committed);
    }

    // Never copy screenshots
    for (const excluded of PROMOTE_EXCLUDE_FILES) {
      const accidental = path.join(outDir, excluded);
      if (fs.existsSync(accidental)) {
        fs.unlinkSync(accidental);
      }
    }

    const provenance = {
      promoted_from: sourceDir,
      workflow,
      run_id: runId,
      promoted_at: new Date().toISOString(),
      copied,
      excluded: [...PROMOTE_EXCLUDE_FILES],
      note: "Promoted from sanitized live-captures only. Screenshots excluded.",
    };
    writeJsonAtomic(path.join(outDir, "promote-meta.json"), provenance);
    copied.push("promote-meta.json");

    if (options.db) {
      completeIdempotencyKey(options.db, key, outDir);
    }

    return {
      ...baseResult,
      status: "promoted",
      copied,
      evidence: `Promoted ${copied.length} files to ${outDir}`,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (options.db) {
      try {
        failIdempotencyKey(options.db, key, reason);
      } catch {
        // claim may not have happened
      }
    }
    return {
      ...baseResult,
      status: "failed",
      copied: [],
      evidence: reason,
    };
  }
}
