import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "../storage/atomicJson.js";
import { sanitizeHtml, sanitizeNetworkMetadata, sanitizeText } from "./sanitize.js";
import {
  CAPTURE_FILES,
  type JobRightWorkflow,
  captureRunDir,
  makeCaptureRunId,
} from "./workflows.js";

export type VisibleLabel = {
  tag: string;
  role: string | null;
  text: string;
  href?: string;
};

export type IframeInfo = {
  src: string | null;
  name: string | null;
  title: string | null;
  index: number;
};

export type RouteEvent = {
  at: string;
  url: string;
  kind: "goto" | "framenavigated" | "popup" | "download" | "manual-capture";
  detail?: string;
};

export type CaptureBundle = {
  workflow: JobRightWorkflow;
  runId: string;
  capturedAt: string;
  url: string;
  title: string;
  domHtml: string;
  a11yText: string;
  labels: VisibleLabel[];
  iframes: IframeInfo[];
  network: Array<Record<string, unknown>>;
  pages: Array<{ url: string; title: string }>;
  downloads: Array<{ url: string; suggestedFilename: string }>;
  routeLog: RouteEvent[];
  screenshotPng: Buffer;
};

export type WrittenCapture = {
  dir: string;
  files: string[];
  metaPath: string;
};

export function sanitizeCaptureBundle(bundle: CaptureBundle): CaptureBundle {
  const labels = bundle.labels ?? [];
  const iframes = bundle.iframes ?? [];
  const network = bundle.network ?? [];
  const pages = bundle.pages ?? [];
  const downloads = bundle.downloads ?? [];
  const routeLog = bundle.routeLog ?? [];

  return {
    ...bundle,
    url: sanitizeText(bundle.url ?? ""),
    title: sanitizeText(bundle.title ?? ""),
    domHtml: sanitizeHtml(bundle.domHtml ?? ""),
    a11yText: sanitizeText(bundle.a11yText ?? ""),
    labels: labels.map((l) => ({
      ...l,
      text: sanitizeText(l.text),
      ...(l.href !== undefined ? { href: sanitizeText(l.href) } : {}),
    })),
    iframes: iframes.map((f) => ({
      ...f,
      src: f.src ? sanitizeText(f.src) : null,
      name: f.name ? sanitizeText(f.name) : null,
      title: f.title ? sanitizeText(f.title) : null,
    })),
    network: sanitizeNetworkMetadata(network),
    pages: pages.map((p) => ({
      url: sanitizeText(p.url),
      title: sanitizeText(p.title),
    })),
    downloads: downloads.map((d) => ({
      url: sanitizeText(d.url),
      suggestedFilename: sanitizeText(d.suggestedFilename),
    })),
    routeLog: routeLog.map((r) => ({
      ...r,
      url: sanitizeText(r.url),
      ...(r.detail !== undefined ? { detail: sanitizeText(r.detail) } : {}),
    })),
  };
}

export function writeCaptureBundle(
  bundle: CaptureBundle,
  root?: string,
): WrittenCapture {
  const sanitized = sanitizeCaptureBundle(bundle);
  const dir = captureRunDir(sanitized.workflow, sanitized.runId, root);
  fs.mkdirSync(dir, { recursive: true });

  const files: string[] = [];
  const write = (name: string, content: string | Buffer): void => {
    const full = path.join(dir, name);
    fs.writeFileSync(full, content);
    files.push(name);
  };

  write(CAPTURE_FILES.screenshot, sanitized.screenshotPng);
  write(CAPTURE_FILES.url, `${sanitized.url}\n`);
  write(CAPTURE_FILES.dom, sanitized.domHtml);
  write(CAPTURE_FILES.a11y, sanitized.a11yText);
  writeJsonAtomic(path.join(dir, CAPTURE_FILES.labels), sanitized.labels);
  files.push(CAPTURE_FILES.labels);
  writeJsonAtomic(path.join(dir, CAPTURE_FILES.iframes), sanitized.iframes);
  files.push(CAPTURE_FILES.iframes);
  writeJsonAtomic(path.join(dir, CAPTURE_FILES.network), sanitized.network);
  files.push(CAPTURE_FILES.network);
  writeJsonAtomic(path.join(dir, CAPTURE_FILES.pages), sanitized.pages);
  files.push(CAPTURE_FILES.pages);
  writeJsonAtomic(path.join(dir, CAPTURE_FILES.downloads), sanitized.downloads);
  files.push(CAPTURE_FILES.downloads);
  writeJsonAtomic(path.join(dir, CAPTURE_FILES.routeLog), sanitized.routeLog);
  files.push(CAPTURE_FILES.routeLog);

  const meta = {
    workflow: sanitized.workflow,
    run_id: sanitized.runId,
    captured_at: sanitized.capturedAt,
    url: sanitized.url,
    title: sanitized.title,
    files: Object.values(CAPTURE_FILES),
    note: "Sanitized live capture. Do not commit fixtures/live-captures/.",
  };
  writeJsonAtomic(path.join(dir, CAPTURE_FILES.meta), meta);
  files.push(CAPTURE_FILES.meta);

  return {
    dir,
    files,
    metaPath: path.join(dir, CAPTURE_FILES.meta),
  };
}

/**
 * Copy sanitized DOM into tests/fixtures/jobright/{workflow}/ for committed fixtures.
 * Only writes HTML + labels (no screenshots/network by default).
 */
export function deriveCommittedFixture(options: {
  workflow: JobRightWorkflow;
  captureDir: string;
  fixturesRoot?: string;
}): { outDir: string } {
  const outDir = path.join(
    options.fixturesRoot ?? path.join(process.cwd(), "tests", "fixtures", "jobright"),
    options.workflow,
  );
  fs.mkdirSync(outDir, { recursive: true });
  const domSrc = path.join(options.captureDir, CAPTURE_FILES.dom);
  const labelsSrc = path.join(options.captureDir, CAPTURE_FILES.labels);
  const a11ySrc = path.join(options.captureDir, CAPTURE_FILES.a11y);
  if (!fs.existsSync(domSrc)) {
    throw new Error(`Missing ${domSrc}`);
  }
  fs.copyFileSync(domSrc, path.join(outDir, "dom.sanitized.html"));
  if (fs.existsSync(labelsSrc)) {
    fs.copyFileSync(labelsSrc, path.join(outDir, "labels.json"));
  }
  if (fs.existsSync(a11ySrc)) {
    fs.copyFileSync(a11ySrc, path.join(outDir, "a11y.sanitized.yml"));
  }
  writeJsonAtomic(path.join(outDir, "source-meta.json"), {
    derived_from: options.captureDir,
    workflow: options.workflow,
    derived_at: new Date().toISOString(),
  });
  return { outDir };
}

export function newCaptureRunId(): string {
  return makeCaptureRunId();
}
