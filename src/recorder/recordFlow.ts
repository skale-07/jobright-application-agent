import type { Request, Response } from "playwright";
import { PlaywrightServiceSession } from "../auth/serviceSession.js";
import { getServiceAuthConfig } from "../auth/serviceRegistry.js";
import { requireStorageState, storageStateExists } from "../auth/storageStateManager.js";
import { logger } from "../logging/logger.js";
import { waitForEnter } from "../util/stdin.js";
import {
  deriveCommittedFixture,
  newCaptureRunId,
  writeCaptureBundle,
  type RouteEvent,
  type WrittenCapture,
} from "./captureWriter.js";
import { capturePageState } from "./pageExtract.js";
import {
  JOBRIGHT_WORKFLOWS,
  WORKFLOW_GUIDANCE,
  defaultJobRightStartUrl,
  liveCapturesRoot,
  type JobRightWorkflow,
} from "./workflows.js";

function interestingNetwork(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (/\.(png|jpe?g|gif|svg|woff2?|css|ico)(\?|$)/i.test(u.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

export type RecordJobRightOptions = {
  workflows?: JobRightWorkflow[];
  deriveFixtures?: boolean;
  startUrl?: string;
  capturesRoot?: string;
};

export async function runJobRightRecorder(
  options: RecordJobRightOptions = {},
): Promise<WrittenCapture[]> {
  const workflows = options.workflows?.length
    ? options.workflows
    : [...JOBRIGHT_WORKFLOWS];
  const cfg = getServiceAuthConfig("jobright");

  if (!storageStateExists(cfg.storageStatePath)) {
    throw new Error(
      `JobRight storage state missing. Run: npm run login:jobright\nExpected: ${cfg.storageStatePath}`,
    );
  }
  requireStorageState(cfg.storageStatePath);

  const startUrl = options.startUrl ?? defaultJobRightStartUrl();
  const capturesRoot = options.capturesRoot ?? liveCapturesRoot();
  const written: WrittenCapture[] = [];

  console.log("\nJobRight recorder (Phase 2b)");
  console.log(`Workflows: ${workflows.join(", ")}`);
  console.log(`Captures root: ${capturesRoot}`);
  console.log("Navigate in the browser to the requested UI, then press Enter here to capture.\n");

  const session = new PlaywrightServiceSession({
    service: "jobright",
    headless: false,
    slowMoMs: 40,
    acceptDownloads: true,
  });
  await session.open();
  const context = session.getContext();

  const network: Array<Record<string, unknown>> = [];
  const pagesMeta: Array<{ url: string; title: string }> = [];
  const downloads: Array<{ url: string; suggestedFilename: string }> = [];
  const routeLog: RouteEvent[] = [];

  const onRequest = (req: Request): void => {
    if (!interestingNetwork(req.url())) return;
    network.push({
      at: new Date().toISOString(),
      phase: "request",
      method: req.method(),
      url: req.url(),
      resourceType: req.resourceType(),
      headers: req.headers(),
    });
  };
  const onResponse = (res: Response): void => {
    if (!interestingNetwork(res.url())) return;
    network.push({
      at: new Date().toISOString(),
      phase: "response",
      status: res.status(),
      url: res.url(),
      headers: res.headers(),
    });
  };

  context.on("request", onRequest);
  context.on("response", onResponse);
  context.on("page", async (p) => {
    try {
      await p
        .waitForLoadState("domcontentloaded", { timeout: 15_000 })
        .catch(() => undefined);
      pagesMeta.push({ url: p.url(), title: await p.title().catch(() => "") });
      routeLog.push({
        at: new Date().toISOString(),
        url: p.url(),
        kind: "popup",
        detail: "new page/tab",
      });
    } catch {
      // ignore
    }
  });

  try {
    const page = await session.newPage({ purpose: "recorder" });
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      routeLog.push({
        at: new Date().toISOString(),
        url: frame.url(),
        kind: "framenavigated",
      });
    });
    page.on("download", (download) => {
      downloads.push({
        url: download.url(),
        suggestedFilename: download.suggestedFilename(),
      });
      routeLog.push({
        at: new Date().toISOString(),
        url: download.url(),
        kind: "download",
        detail: download.suggestedFilename(),
      });
    });

    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    routeLog.push({
      at: new Date().toISOString(),
      url: page.url(),
      kind: "goto",
      detail: "start",
    });

    for (const workflow of workflows) {
      console.log(`\n=== Workflow: ${workflow} ===`);
      console.log(WORKFLOW_GUIDANCE[workflow]);
      await waitForEnter(
        `Press Enter to capture "${workflow}" (or rearrange the UI first)... `,
      );

      const state = await capturePageState(page);
      for (const p of context.pages()) {
        pagesMeta.push({
          url: p.url(),
          title: await p.title().catch(() => ""),
        });
      }

      const runId = newCaptureRunId();
      const result = writeCaptureBundle(
        {
          workflow,
          runId,
          capturedAt: new Date().toISOString(),
          url: state.url,
          title: state.title,
          domHtml: state.domHtml,
          a11yText: state.a11yText,
          labels: state.labels,
          iframes: state.iframes,
          network: network.slice(-200),
          pages: dedupePages(pagesMeta),
          downloads: [...downloads],
          routeLog: [...routeLog],
          screenshotPng: state.screenshotPng,
        },
        capturesRoot,
      );
      written.push(result);
      logger.info("jobright capture written", {
        service: "jobright",
        action: "record_capture",
        metadata: { workflow, dir: result.dir },
      });
      console.log(`Saved: ${result.dir}`);

      if (options.deriveFixtures) {
        console.log(
          "Prefer explicit promotion: npm run recorder:promote -- --run <runId> --workflow <name>",
        );
        const derived = deriveCommittedFixture({
          workflow,
          captureDir: result.dir,
        });
        console.log(`Derived fixture (review required): ${derived.outDir}`);
      }
    }
  } finally {
    await session.close();
  }

  console.log(`\nDone. ${written.length} capture(s) under ${capturesRoot}`);
  console.log(
    "Promote with: npm run recorder:promote -- --run <runId> --workflow <name>",
  );
  return written;
}

function dedupePages(
  pages: Array<{ url: string; title: string }>,
): Array<{ url: string; title: string }> {
  const seen = new Set<string>();
  const out: Array<{ url: string; title: string }> = [];
  for (const p of pages) {
    const key = `${p.url}|${p.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** Dry helper for tests — no browser. */
export function listRecorderWorkflows(): JobRightWorkflow[] {
  return [...JOBRIGHT_WORKFLOWS];
}
