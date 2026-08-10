import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import {
  clickApplyAndCaptureExternalUrl,
  readExternalApplyHrefs,
} from "../../src/jobright/navigateToEmployer.js";
import { assertNavigationAllowed } from "../../src/navigation/navigationGuards.js";
import { storeResolvedEmployerUrl } from "../../src/navigation/storeResult.js";
import {
  getEmployerApplicationUrl,
  runPipeline,
} from "../../src/pipeline/runPipeline.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import {
  closeDatabase,
  migrate,
  openDatabase,
  type Db,
} from "../../src/storage/db/client.js";
import { createApplication } from "../../src/queue/stateMachine.js";
import { upsertJobByFingerprint } from "../../src/jobs/repository.js";
import { listOpenReviewItems } from "../../src/queue/reviewItems.js";
import { getApplication } from "../../src/queue/stateMachine.js";
import { resetConfigCache } from "../../src/config/index.js";
import {
  applyControlledFillEnv,
  applySafeFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";

const LEVER_URL =
  "https://jobs.lever.co/acme/a1b2c3d4-e5f6-7890-abcd-ef1234567890/apply";

const JOB_PAGE_HTML = `<!DOCTYPE html><html><body>
  <a href="https://careers.example.com/apply/1" target="_blank">Company careers</a>
  <a href="${LEVER_URL}">Apply on Lever</a>
  <a href="http://insecure.example.com/apply">insecure</a>
  <a href="https://jobright.ai/jobs/info/abc123">internal</a>
</body></html>`;

describe("navigation deterministic phases (N2)", () => {
  useIsolatedFillEnv("safe");

  beforeEach(() => {
    applySafeFillEnv();
  });

  it("fails closed without NAVIGATION_ENABLED (UNIT_CONFIRMED)", () => {
    expect(() => assertNavigationAllowed("test")).toThrow(/NAVIGATION_ENABLED/);
  });

  it(
    "phase A reads external hrefs, known-ATS first, excluding http and jobright links (FIXTURE_CONFIRMED)",
    async () => {
      await withFixtureHtmlPage(JOB_PAGE_HTML, async (page) => {
        const hrefs = await readExternalApplyHrefs(page);
        expect(hrefs[0]).toBe(LEVER_URL);
        expect(hrefs).toContain("https://careers.example.com/apply/1");
        expect(hrefs.join(" ")).not.toMatch(/insecure|jobright\.ai/);
      });
    },
    30_000,
  );

  it(
    "phase B captures a popup URL, guarded by the flag (FIXTURE_CONFIRMED)",
    async () => {
      const html = `<!DOCTYPE html><html><body>
        <button onclick="window.open('${LEVER_URL}')">Apply</button>
      </body></html>`;
      await withFixtureHtmlPage(html, async (page) => {
        const fakeSession = {
          getContext: () => page.context(),
        } as Parameters<typeof clickApplyAndCaptureExternalUrl>[0];

        await expect(
          clickApplyAndCaptureExternalUrl(fakeSession, page),
        ).rejects.toThrow(/NAVIGATION_ENABLED/);

        applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
        resetConfigCache();
        try {
          await page.context().route("**/*", (route) =>
            route.fulfill({
              body: "<html><body>lever form</body></html>",
              contentType: "text/html",
            }),
          );
          const capture = await clickApplyAndCaptureExternalUrl(
            fakeSession,
            page,
          );
          expect(capture.via).toBe("popup");
          expect(capture.url).toBe(LEVER_URL);
          expect(capture.clicks).toBe(1);
        } finally {
          applySafeFillEnv();
        }
      });
    },
    45_000,
  );

  it(
    "phase B broad tier matches 'Apply on company site' and skips autofill/easy-apply decoys (FIXTURE_CONFIRMED)",
    async () => {
      // Live-run regression: pages whose only real control was named
      // "Apply now" / "Apply on company site" fell through the exact-name
      // tier and burned the agent phase. Decoys come FIRST in the DOM to
      // prove the exclusion filter is doing the choosing, not luck.
      const html = `<!DOCTYPE html><html><body>
        <button onclick="window.open('https://evil.example.com/autofill')">Apply with Autofill</button>
        <button onclick="window.open('https://evil.example.com/easy')">Easy Apply</button>
        <button onclick="window.open('${LEVER_URL}')">Apply on company site</button>
      </body></html>`;
      await withFixtureHtmlPage(html, async (page) => {
        const fakeSession = {
          getContext: () => page.context(),
        } as Parameters<typeof clickApplyAndCaptureExternalUrl>[0];
        applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
        resetConfigCache();
        try {
          await page.context().route("**/*", (route) =>
            route.fulfill({
              body: "<html><body>lever form</body></html>",
              contentType: "text/html",
            }),
          );
          const capture = await clickApplyAndCaptureExternalUrl(
            fakeSession,
            page,
          );
          expect(capture.url).toBe(LEVER_URL);
          expect(capture.notes.join(" ")).toMatch(/broad name tier/);
        } finally {
          applySafeFillEnv();
        }
      });
    },
    45_000,
  );

  it(
    "phase B reports no control when only excluded apply-like names exist (FIXTURE_CONFIRMED)",
    async () => {
      const html = `<!DOCTYPE html><html><body>
        <button>Apply with Autofill</button>
        <button>Easy Apply</button>
      </body></html>`;
      await withFixtureHtmlPage(html, async (page) => {
        const fakeSession = {
          getContext: () => page.context(),
        } as Parameters<typeof clickApplyAndCaptureExternalUrl>[0];
        applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
        resetConfigCache();
        try {
          const capture = await clickApplyAndCaptureExternalUrl(
            fakeSession,
            page,
          );
          expect(capture.url).toBeNull();
          expect(capture.notes.join(" ")).toMatch(/no standard Apply control/);
        } finally {
          applySafeFillEnv();
        }
      });
    },
    45_000,
  );
});

describe("storeResolvedEmployerUrl + pipeline routing (N2)", () => {
  useIsolatedFillEnv("safe");

  let db: Db | null = null;
  let dbPath = "";

  beforeEach(() => {
    applySafeFillEnv();
    dbPath = path.join(os.tmpdir(), `jaa-nav-${randomUUID()}.sqlite`);
    process.env.DATABASE_PATH = dbPath;
    resetConfigCache();
    db = openDatabase(dbPath);
    migrate(db);
  });

  afterEach(() => {
    if (db) closeDatabase(db);
    db = null;
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.rmSync(p, { force: true });
    }
    applySafeFillEnv();
  });

  function seedApp(state = "APPLICATION_OPENING"): string {
    const job = upsertJobByFingerprint(db!, {
      jobrightJobId: `6a${randomUUID().replace(/-/g, "").slice(0, 22)}`,
      applicationUrl: `https://jobright.ai/jobs/info/6a${randomUUID().replace(/-/g, "").slice(0, 22)}`,
      company: "Acme",
      role: "SWE",
    });
    const app = createApplication(db!, { jobId: job.id });
    db!
      .prepare(`UPDATE applications SET state = ? WHERE id = ?`)
      .run(state, app.id);
    return app.id;
  }

  it("stores a supported ATS URL normalized with nav annotations (UNIT_CONFIRMED)", () => {
    const appId = seedApp();
    const stored = storeResolvedEmployerUrl(
      db!,
      appId,
      "https://jobs.lever.co/acme/a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      { runId: "nav-1", session: "ephemeral" },
    );
    expect(stored.ats).toBe("lever");
    expect(getEmployerApplicationUrl(db!, appId)).toBe(LEVER_URL);
    const raw = JSON.parse(
      (
        db!
          .prepare(
            `SELECT j.raw_json FROM jobs j JOIN applications a ON a.job_id = j.id WHERE a.id = ?`,
          )
          .get(appId) as { raw_json: string }
      ).raw_json,
    ) as Record<string, unknown>;
    expect(raw["nav_run_id"]).toBe("nav-1");
    expect(raw["nav_session"]).toBe("ephemeral");
  });

  it("stores an unsupported https URL verbatim and the pipeline routes UNSUPPORTED_ATS (UNIT_CONFIRMED)", async () => {
    const appId = seedApp();
    const stored = storeResolvedEmployerUrl(
      db!,
      appId,
      "https://careers.example.com/apply/1",
      { runId: "nav-2", session: "ephemeral" },
    );
    expect(stored.ats).toBeNull();
    const report = await runPipeline({ db: db!, applicationId: appId });
    expect(getApplication(db!, appId)?.state).toBe("UNSUPPORTED_ATS");
    expect(report.applications[0]!.stopped).toBe("review");
  });

  it("refuses malformed and non-https nav results (UNIT_CONFIRMED)", () => {
    const appId = seedApp();
    expect(() =>
      storeResolvedEmployerUrl(db!, appId, "not a url", {
        runId: "nav-3",
        session: "ephemeral",
      }),
    ).toThrow(/malformed URL/);
    expect(() =>
      storeResolvedEmployerUrl(db!, appId, "http://careers.example.com/x", {
        runId: "nav-3",
        session: "ephemeral",
      }),
    ).toThrow(/non-https/);
  });

  it("flag off: APPLICATION_OPENING keeps the MANUAL review dead-end (UNIT_CONFIRMED)", async () => {
    const appId = seedApp();
    const report = await runPipeline({ db: db!, applicationId: appId });
    expect(report.applications[0]!.stopped).toBe("review");
    const items = listOpenReviewItems(db!);
    expect(
      items.some((i) => /Employer application URL unknown/.test(i.title)),
    ).toBe(true);
    expect(getApplication(db!, appId)?.state).toBe("APPLICATION_OPENING");
  });

  it("flag on: a stubbed nav resolution advances the pipeline to ATS_DETECTION (UNIT_CONFIRMED)", async () => {
    const appId = seedApp();
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    resetConfigCache();
    try {
      const report = await runPipeline({
        db: db!,
        applicationId: appId,
        // Keep the post-nav stages offline: inspection reads this fixture
        // instead of fetching the resolved URL.
        fixtureHtmlPath: path.join(
          process.cwd(),
          "tests",
          "fixtures",
          "ats",
          "lever",
          "dom.sanitized.html",
        ),
        navigationRunner: async ({ db: database, applicationId }) => {
          const stored = storeResolvedEmployerUrl(
            database,
            applicationId,
            LEVER_URL,
            { runId: "nav-stub", session: "ephemeral" },
          );
          return {
            run_id: "nav-stub",
            application_id: applicationId,
            jobright_job_id: null,
            method: "anchor_href",
            resolved_url: stored.url,
            resolved_ats: stored.ats,
            wall: "none",
            phase_trace: [],
            agent: null,
            gmail: null,
            need: null,
            session: "ephemeral",
            notes: [],
            congruence: null,
            duplicates: null,
          };
        },
      });
      const steps = report.applications[0]!.steps.map((s) => s.note);
      expect(steps.some((n) => /nav resolved employer URL/.test(n))).toBe(true);
      expect(steps.some((n) => /lever URL validated/.test(n))).toBe(true);
    } finally {
      applySafeFillEnv();
    }
  }, 20_000);

  it("flag on: a captcha wall routes to CAPTCHA_REQUIRED with a review item (UNIT_CONFIRMED)", async () => {
    const appId = seedApp();
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    resetConfigCache();
    try {
      await runPipeline({
        db: db!,
        applicationId: appId,
        navigationRunner: async ({ applicationId }) => ({
          run_id: "nav-wall",
          application_id: applicationId,
          jobright_job_id: null,
          method: null,
          resolved_url: null,
          resolved_ats: null,
          wall: "captcha",
          phase_trace: [],
          agent: null,
          gmail: null,
          need: null,
          session: "ephemeral",
          notes: [],
          congruence: null,
          duplicates: null,
        }),
      });
      expect(getApplication(db!, appId)?.state).toBe("CAPTCHA_REQUIRED");
      expect(
        listOpenReviewItems(db!).some((i) => i.kind === "CAPTCHA_REQUIRED"),
      ).toBe(true);
    } finally {
      applySafeFillEnv();
    }
  });

  it("flag on: a wrong-employer mismatch parks with a named review item (UNIT_CONFIRMED)", async () => {
    const appId = seedApp();
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    resetConfigCache();
    try {
      await runPipeline({
        db: db!,
        applicationId: appId,
        navigationRunner: async ({ applicationId }) => ({
          run_id: "nav-mismatch",
          application_id: applicationId,
          jobright_job_id: null,
          method: null,
          resolved_url: null,
          resolved_ats: null,
          wall: "mismatch",
          phase_trace: [],
          agent: null,
          gmail: null,
          need: null,
          session: "cdp",
          notes: [],
          congruence: {
            verdict: "mismatch",
            slug: "cohere",
            detail: 'slug "cohere" shares nothing with company "Postman"',
            expected_company: "Postman",
            url: "https://jobs.ashbyhq.com/cohere/x/application",
          },
          duplicates: null,
        }),
      });
      expect(getApplication(db!, appId)?.state).toBe("FAILED_RETRYABLE");
      const item = listOpenReviewItems(db!).find((i) =>
        /wrong company/.test(i.title),
      );
      expect(item?.title).toContain("cohere");
      expect(item?.title).toContain("Postman");
    } finally {
      applySafeFillEnv();
    }
  });

  it("flag on: a duplicate-URL wall parks naming the sibling application (UNIT_CONFIRMED)", async () => {
    const appId = seedApp();
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    resetConfigCache();
    try {
      await runPipeline({
        db: db!,
        applicationId: appId,
        navigationRunner: async ({ applicationId }) => ({
          run_id: "nav-dupe",
          application_id: applicationId,
          jobright_job_id: null,
          method: null,
          resolved_url: null,
          resolved_ats: null,
          wall: "duplicate_url",
          phase_trace: [],
          agent: null,
          gmail: null,
          need: null,
          session: "cdp",
          notes: [],
          congruence: null,
          duplicates: [
            {
              application_id: "11111111-2222-3333-4444-555555555555",
              state: "READY_TO_SUBMIT",
              company: "Cohere",
              role: "ML Intern",
            },
          ],
        }),
      });
      expect(getApplication(db!, appId)?.state).toBe("FAILED_RETRYABLE");
      expect(
        listOpenReviewItems(db!).some((i) => /Duplicate posting/.test(i.title)),
      ).toBe(true);
    } finally {
      applySafeFillEnv();
    }
  });

  it("flag on: a budget wall routes to FAILED_RETRYABLE (UNIT_CONFIRMED)", async () => {
    const appId = seedApp();
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    resetConfigCache();
    try {
      await runPipeline({
        db: db!,
        applicationId: appId,
        navigationRunner: async ({ applicationId }) => ({
          run_id: "nav-budget",
          application_id: applicationId,
          jobright_job_id: null,
          method: null,
          resolved_url: null,
          resolved_ats: null,
          wall: "budget",
          phase_trace: [],
          agent: null,
          gmail: null,
          need: null,
          session: "ephemeral",
          notes: [],
          congruence: null,
          duplicates: null,
        }),
      });
      expect(getApplication(db!, appId)?.state).toBe("FAILED_RETRYABLE");
    } finally {
      applySafeFillEnv();
    }
  });
});
