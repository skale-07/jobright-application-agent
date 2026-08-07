import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  migrate,
  openDatabase,
  type Db,
} from "../../src/storage/db/client.js";
import { createApplication } from "../../src/queue/stateMachine.js";
import { upsertJobByFingerprint } from "../../src/jobs/repository.js";
import { ATS_BINDINGS } from "../../src/applications/atsBindings.js";
import { verifyPageBeforeMutationGeneric } from "../../src/ats/shared/preMutationGate.js";
import { isTrustedLeverHost } from "../../src/ats/lever/urlValidation.js";
import { leverSelectorsV1 } from "../../src/ats/lever/selectors.js";
import { runAtsSubmission } from "../../src/applications/submitRun.js";
import { setEmployerApplicationUrl } from "../../src/pipeline/runPipeline.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import {
  applyControlledFillEnv,
  applySafeFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";
import { resetConfigCache } from "../../src/config/index.js";

const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures", "ats");

function fixtureHtml(name: string): string {
  return fs.readFileSync(
    path.join(FIXTURE_DIR, name, "dom.sanitized.html"),
    "utf8",
  );
}

const LEVER_URL =
  "https://jobs.lever.co/acme/a1b2c3d4-e5f6-7890-abcd-ef1234567890/apply";

/** Serve fixture HTML at a real ATS URL so page.url() carries the host. */
async function withRoutedPage(
  html: string,
  url: string,
  fn: (page: import("playwright").Page) => Promise<void>,
): Promise<void> {
  await withFixtureHtmlPage("<html><body></body></html>", async (page) => {
    await page.route("**/*", (route) =>
      route.fulfill({ body: html, contentType: "text/html" }),
    );
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await fn(page);
  });
}

describe("ATS bindings table (W4, UNIT_CONFIRMED)", () => {
  it("declares capabilities honestly per ATS", () => {
    expect(Object.keys(ATS_BINDINGS).sort()).toEqual([
      "ashby",
      "greenhouse",
      "lever",
    ]);
    expect(ATS_BINDINGS.greenhouse.supportsEssayFill).toBe(true);
    expect(ATS_BINDINGS.greenhouse.supportsHealing).toBe(true);
    for (const ats of ["lever", "ashby"] as const) {
      expect(ATS_BINDINGS[ats].supportsEssayFill).toBe(false);
      expect(ATS_BINDINGS[ats].supportsHealing).toBe(false);
    }
  });
});

describe("generic pre-mutation gate (W4, FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  it(
    "passes a lever form on a trusted lever host",
    async () => {
      await withRoutedPage(fixtureHtml("lever"), LEVER_URL, async (page) => {
        const gate = await ATS_BINDINGS.lever.gate(page, LEVER_URL);
        expect(gate.ok).toBe(true);
        expect(gate.finalUrl).toBe(LEVER_URL);
      });
    },
    45_000,
  );

  it(
    "passes an ashby form on a trusted ashby host",
    async () => {
      const url =
        "https://jobs.ashbyhq.com/acme/9b1e0c2a-1234-4abc-8def-1234567890ab/application";
      await withRoutedPage(fixtureHtml("ashby"), url, async (page) => {
        const gate = await ATS_BINDINGS.ashby.gate(page, url);
        expect(gate.ok).toBe(true);
      });
    },
    45_000,
  );

  it(
    "refuses a redirect to a different posting on the same trusted host",
    async () => {
      const otherPosting =
        "https://jobs.lever.co/acme/ffffffff-0000-1111-2222-333344445555/apply";
      await withRoutedPage(fixtureHtml("lever"), otherPosting, async (page) => {
        const gate = await ATS_BINDINGS.lever.gate(
          page,
          LEVER_URL,
          LEVER_URL,
        );
        expect(gate.ok).toBe(false);
        expect(gate.failureCode).toBe("POSTING_MISMATCH");
      });
    },
    45_000,
  );

  it(
    "refuses an untrusted final host even with a lever-looking form",
    async () => {
      const url = "https://careers.evil.example.com/acme/apply";
      await withRoutedPage(fixtureHtml("lever"), url, async (page) => {
        const gate = await verifyPageBeforeMutationGeneric(page, {
          isTrustedHost: isTrustedLeverHost,
          formMarkers: leverSelectorsV1.formMarkers,
        });
        expect(gate.ok).toBe(false);
        expect(gate.failureCode).toBe("UNTRUSTED_FINAL_HOST");
      });
    },
    45_000,
  );

  it(
    "refuses when no application form is present on the trusted host",
    async () => {
      await withRoutedPage(
        "<html><body><h1>Job closed</h1></body></html>",
        LEVER_URL,
        async (page) => {
          const gate = await ATS_BINDINGS.lever.gate(page, LEVER_URL);
          expect(gate.ok).toBe(false);
          expect(gate.failureCode).toBe("NO_APPLICATION_FORM");
        },
      );
    },
    45_000,
  );

  it(
    "refuses behind a login wall",
    async () => {
      const loginHtml =
        "<html><head><title>Sign in</title></head><body><h1>Sign in to apply</h1><form action='/login'><input type='password' name='password'><button>Log in</button></form></body></html>";
      await withRoutedPage(
        loginHtml,
        "https://jobs.lever.co/login",
        async (page) => {
          const gate = await ATS_BINDINGS.lever.gate(page, LEVER_URL);
          expect(gate.ok).toBe(false);
          expect(["LOGIN_WALL", "NO_APPLICATION_FORM"]).toContain(
            gate.failureCode,
          );
        },
      );
    },
    45_000,
  );
});

describe("runAtsSubmission dispatch (W4, UNIT_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  let db: Db | null = null;
  let dbPath = "";

  afterEach(() => {
    applySafeFillEnv();
    if (db) closeDatabase(db);
    db = null;
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (p && fs.existsSync(p)) fs.rmSync(p, { force: true });
    }
  });

  function freshDb(): Db {
    dbPath = path.join(os.tmpdir(), `jaa-atssub-${randomUUID()}.sqlite`);
    process.env.DATABASE_PATH = dbPath;
    resetConfigCache();
    const opened = openDatabase(dbPath);
    migrate(opened);
    db = opened;
    return opened;
  }

  function seedApp(database: Db, employerUrl?: string): string {
    const job = upsertJobByFingerprint(database, {
      jobrightJobId: `jr-${randomUUID().slice(0, 8)}`,
      applicationUrl: `https://jobright.ai/jobs/info/${randomUUID().slice(0, 24)}`,
      company: "Acme",
      role: "SWE",
    });
    const app = createApplication(database, { jobId: job.id });
    database
      .prepare(`UPDATE applications SET state = 'READY_TO_SUBMIT' WHERE id = ?`)
      .run(app.id);
    if (employerUrl) setEmployerApplicationUrl(database, app.id, employerUrl);
    return app.id;
  }

  it("refuses with flags off before any DB write, for a lever-bound app", async () => {
    const database = freshDb();
    const appId = seedApp(database, LEVER_URL);
    await expect(
      runAtsSubmission({ db: database, applicationId: appId }),
    ).rejects.toThrow(/SUBMIT_ENABLED|FORM_FILL_ENABLED|DRY_RUN/);
    const subs = database
      .prepare(`SELECT COUNT(*) AS n FROM submissions`)
      .get() as { n: number };
    expect(subs.n).toBe(0);
  });

  it("refuses an app whose URL no supported ATS claims, with aggregated reasons", async () => {
    const database = freshDb();
    const appId = seedApp(database);
    // Bypass setEmployerApplicationUrl (which would refuse) to simulate a
    // legacy row carrying an unsupported URL.
    const row = database
      .prepare(
        `SELECT j.id, j.raw_json FROM jobs j JOIN applications a ON a.job_id = j.id WHERE a.id = ?`,
      )
      .get(appId) as { id: string; raw_json: string };
    const raw = JSON.parse(row.raw_json) as Record<string, unknown>;
    raw["employer_application_url"] = "https://careers.example.com/apply/1";
    database
      .prepare(`UPDATE jobs SET raw_json = ? WHERE id = ?`)
      .run(JSON.stringify(raw), row.id);

    applyControlledFillEnv({
      FORM_FILL_ENABLED: "true",
      DRY_RUN: "false",
      SUBMIT_ENABLED: "true",
    });
    const report = await runAtsSubmission({ db: database, applicationId: appId });
    expect(report.outcome).toBe("REFUSED");
    expect(report.reason).toMatch(/failed ATS validation/);
    expect(report.reason).toMatch(/greenhouse: .*lever: .*ashby: /s);
  });

  it("a lever URL clears the URL gate and proceeds to the resume gate", async () => {
    const database = freshDb();
    const appId = seedApp(database, LEVER_URL);
    applyControlledFillEnv({
      FORM_FILL_ENABLED: "true",
      DRY_RUN: "false",
      SUBMIT_ENABLED: "true",
    });
    const report = await runAtsSubmission({ db: database, applicationId: appId });
    // Refusal reason proves the lever URL passed ATS validation (previously:
    // "Employer URL failed Greenhouse validation") and dispatch reached the
    // next layered gate. No browser/network involved before that gate.
    expect(report.outcome).toBe("REFUSED");
    expect(report.reason).toMatch(/No verified resume material/);
  });
});
