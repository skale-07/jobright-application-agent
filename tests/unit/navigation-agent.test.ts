import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import {
  runNavigation,
  type NavSession,
} from "../../src/navigation/runNavigation.js";
import { navigateViaSidecar } from "../../src/agent/navigate.js";
import { getEmployerApplicationUrl } from "../../src/pipeline/runPipeline.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import {
  closeDatabase,
  migrate,
  openDatabase,
  type Db,
} from "../../src/storage/db/client.js";
import { createApplication } from "../../src/queue/stateMachine.js";
import { upsertJobByFingerprint } from "../../src/jobs/repository.js";
import { resetConfigCache } from "../../src/config/index.js";
import {
  applyControlledFillEnv,
  applySafeFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";

const LEVER_URL =
  "https://jobs.lever.co/acme/a1b2c3d4-e5f6-7890-abcd-ef1234567890/apply";

/** Fake sidecar: node -e printing a canned navigate result. */
function fakeSidecar(result: unknown): { command: string; args: string[] } {
  return {
    command: "node",
    args: ["-e", `console.log(${JSON.stringify(JSON.stringify(result))})`],
  };
}

function okResult(finalUrl: string) {
  return {
    status: "ok",
    final_url: finalUrl,
    wall: "none",
    steps_used: 5,
    domains_visited: ["jobright.ai", "jobs.lever.co"],
    notes: ["reached form"],
  };
}

describe("navigation agent phase (N3)", () => {
  useIsolatedFillEnv("safe");

  let db: Db | null = null;
  let dbPath = "";

  beforeEach(() => {
    applySafeFillEnv();
    dbPath = path.join(os.tmpdir(), `jaa-navagent-${randomUUID()}.sqlite`);
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

  function seedApp(): string {
    const jrId = `6a${randomUUID().replace(/-/g, "").slice(0, 22)}`;
    const job = upsertJobByFingerprint(db!, {
      jobrightJobId: jrId,
      applicationUrl: `https://jobright.ai/jobs/info/${jrId}`,
      company: "Acme",
      role: "SWE",
    });
    const app = createApplication(db!, { jobId: job.id });
    db!
      .prepare(`UPDATE applications SET state = 'APPLICATION_OPENING' WHERE id = ?`)
      .run(app.id);
    return app.id;
  }

  async function runWithAgentAndGmail(
    appId: string,
    sidecar: { command: string; args: string[] },
    gmailWaiter?: Parameters<typeof runNavigation>[0]["gmailWaiterOverride"],
  ) {
    const html =
      "<html><body><h1>Some job</h1><p>description text</p></body></html>";
    return withFixtureHtmlPage("<html><body></body></html>", async (page: Page) => {
      await page
        .context()
        .route("**/*", (route) =>
          route.fulfill({ body: html, contentType: "text/html" }),
        );
      const session: NavSession = {
        open: async () => {},
        newPage: async () => page,
        getContext: () => page.context(),
        close: async () => {},
      };
      return runNavigation({
        db: db!,
        applicationId: appId,
        sessionOverride: session,
        skipAuthLossCheck: true,
        agentPhaseOverride: true,
        agentCommandOverride: sidecar,
        ...(gmailWaiter ? { gmailWaiterOverride: gmailWaiter } : {}),
      });
    });
  }

  async function runWithAgent(
    appId: string,
    sidecar: { command: string; args: string[] },
  ) {
    // Job page with no anchors/apply control: phases A/B stay unresolved so
    // the run reaches the agent phase.
    const html = "<html><body><h1>Some job</h1><p>description text</p></body></html>";
    return withFixtureHtmlPage("<html><body></body></html>", async (page: Page) => {
      await page
        .context()
        .route("**/*", (route) =>
          route.fulfill({ body: html, contentType: "text/html" }),
        );
      const session: NavSession = {
        open: async () => {},
        newPage: async () => page,
        getContext: () => page.context(),
        close: async () => {},
      };
      return runNavigation({
        db: db!,
        applicationId: appId,
        sessionOverride: session,
        skipAuthLossCheck: true,
        agentPhaseOverride: true,
        agentCommandOverride: sidecar,
      });
    });
  }

  it(
    "an ok agent result stores the employer URL with method agent (FIXTURE_CONFIRMED)",
    async () => {
      const appId = seedApp();
      applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
      resetConfigCache();
      try {
        const report = await runWithAgent(appId, fakeSidecar(okResult(LEVER_URL)));
        expect(report.method).toBe("agent");
        expect(report.resolved_ats).toBe("lever");
        expect(report.wall).toBe("none");
        expect(report.agent?.steps_used).toBe(5);
        expect(getEmployerApplicationUrl(db!, appId)).toBe(LEVER_URL);
      } finally {
        applySafeFillEnv();
      }
    },
    45_000,
  );

  it(
    "needs_input surfaces the need payload as an auth wall, storing nothing (FIXTURE_CONFIRMED)",
    async () => {
      const appId = seedApp();
      applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
      resetConfigCache();
      try {
        const report = await runWithAgent(
          appId,
          fakeSidecar({
            status: "needs_input",
            final_url: "https://jobs.ashbyhq.com/acme/verify",
            wall: "auth",
            steps_used: 8,
            domains_visited: ["jobs.ashbyhq.com"],
            notes: [],
            need: {
              kind: "verification_email",
              sent_to: "candidate@example.com",
              requested_at: "2026-08-07T00:00:00Z",
            },
          }),
        );
        expect(report.wall).toBe("auth");
        expect(report.need?.sent_to).toBe("candidate@example.com");
        expect(report.resolved_url).toBeNull();
        expect(getEmployerApplicationUrl(db!, appId)).toBeNull();
      } finally {
        applySafeFillEnv();
      }
    },
    45_000,
  );

  it(
    "submit_risk is honored as a hard stop with nothing stored (FIXTURE_CONFIRMED)",
    async () => {
      const appId = seedApp();
      applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
      resetConfigCache();
      try {
        const report = await runWithAgent(
          appId,
          fakeSidecar({
            status: "error",
            final_url: null,
            wall: "submit_risk",
            steps_used: 3,
            domains_visited: [],
            notes: [],
            reason: "agent stopped: submit_risk",
          }),
        );
        expect(report.wall).toBe("submit_risk");
        expect(getEmployerApplicationUrl(db!, appId)).toBeNull();
      } finally {
        applySafeFillEnv();
      }
    },
    45_000,
  );

  it(
    "malformed sidecar output degrades to a budget wall, never a store (FIXTURE_CONFIRMED)",
    async () => {
      const appId = seedApp();
      applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
      resetConfigCache();
      try {
        const report = await runWithAgent(appId, {
          command: "node",
          args: ["-e", "console.log('not json at all')"],
        });
        expect(report.wall).toBe("budget");
        expect(report.notes.join(" ")).toMatch(/agent phase failed/);
        expect(getEmployerApplicationUrl(db!, appId)).toBeNull();
      } finally {
        applySafeFillEnv();
      }
    },
    45_000,
  );

  it(
    "an off-domain final_url is rejected on the Node side (FIXTURE_CONFIRMED)",
    async () => {
      const appId = seedApp();
      applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
      resetConfigCache();
      try {
        const report = await runWithAgent(
          appId,
          fakeSidecar(okResult("https://evil.example.com/apply")),
        );
        expect(report.wall).toBe("budget");
        expect(report.notes.join(" ")).toMatch(/outside allowed domains/);
        expect(getEmployerApplicationUrl(db!, appId)).toBeNull();
      } finally {
        applySafeFillEnv();
      }
    },
    45_000,
  );

  it(
    "gmail micro-turn: needs_input → code retrieved → continuation resolves (FIXTURE_CONFIRMED)",
    async () => {
      const appId = seedApp();
      applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
      resetConfigCache();
      try {
        // Turn-aware fake sidecar: first spawn (no resume) pauses on email
        // verification; the continuation (resume present) must carry the
        // injected code and then resolves.
        const script = [
          "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{",
          "const t=JSON.parse(d);",
          "if(t.resume){",
          "if(t.resume.injected.code!=='482193'){console.log(JSON.stringify({status:'error',final_url:null,wall:'budget',steps_used:0,domains_visited:[],notes:['wrong code injected'],reason:'bad'}));return;}",
          `console.log(JSON.stringify({status:'ok',final_url:'https://jobs.ashbyhq.com/acme/9b1e0c2a-1234-4abc-8def-1234567890ab/application',wall:'none',steps_used:2,domains_visited:['jobs.ashbyhq.com'],notes:['continuation ok']}));`,
          "}else{",
          "console.log(JSON.stringify({status:'needs_input',final_url:'https://jobs.ashbyhq.com/acme/login',wall:'auth',steps_used:4,domains_visited:['jobs.ashbyhq.com'],notes:[],need:{kind:'verification_email',sent_to:'candidate@example.com',requested_at:'2026-08-07T00:00:00Z'}}));",
          "}});",
        ].join("");
        const report = await runWithAgentAndGmail(
          appId,
          { command: "node", args: ["-e", script] },
          async () => ({
            kind: "code",
            code: "482193",
            messageId: "msg-9",
            pollsUsed: 2,
          }),
        );
        expect(report.method).toBe("agent");
        expect(report.resolved_ats).toBe("ashby");
        expect(report.agent?.turns_used).toBe(2);
        expect(report.gmail).toEqual({ polls_used: 2, matched_message_id: "msg-9" });
        expect(report.notes.join(" ")).toMatch(/continuation ok/);
      } finally {
        applySafeFillEnv();
      }
    },
    45_000,
  );

  it("navigateViaSidecar rejects a jobright-hosted final_url (UNIT_CONFIRMED)", async () => {
    await expect(
      navigateViaSidecar({
        task: {
          task_version: 1,
          task_type: "navigate",
          goal: "test",
          start_url: "https://jobright.ai/jobs/info/abc",
          cdp_url: "http://127.0.0.1:9222",
          allowed_domains: ["jobright.ai"],
          max_steps: 5,
          timeout_ms: 30_000,
          credentials: { available: false },
          gmail_available: false,
        },
        commandOverride: fakeSidecar(okResult("https://jobright.ai/jobs/info/abc")),
      }),
    ).rejects.toThrow(/jobright-hosted/);
  });
});
