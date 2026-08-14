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
import { getOrCreateAccount } from "../../src/accounts/vault.js";
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

  /**
   * Operator directive 2026-08-14: "it literally should not matter whether
   * the system proceeds… other than for logging. ALL the jobs I am
   * applying to are verified since they're on JobRight." A hostname that
   * shares nothing with the company name is almost always the ATS vendor —
   * secure7.saashr.com (TRG) and paycomonline.net (Union Home Mortgage)
   * were both correct URLs and both thrown away. The verdict is recorded;
   * the link is kept; no corrective retry is spent re-finding a page the
   * agent already reached.
   */
  it(
    "a URL whose host names another org is STORED, with the verdict recorded",
    async () => {
      const appId = seedApp(); // company: "Acme"
      const VENDOR_URL =
        "https://jobs.lever.co/othercorp/9b1e0c2a-1234-4abc-8def-1234567890ab/apply";
      applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
      resetConfigCache();
      try {
        const report = await runWithAgent(appId, fakeSidecar(okResult(VENDOR_URL)));
        expect(report.method).toBe("agent");
        expect(report.wall).toBe("none");
        expect(getEmployerApplicationUrl(db!, appId)).toBe(VENDOR_URL);
        // Evidence is still on the report — this is logging, not silence.
        expect(report.congruence?.verdict).toBe("mismatch");
        expect(report.congruence?.expected_company).toBe("Acme");
        expect(report.notes.join(" ")).toMatch(/recorded, not refused/);
        // And no turn was burned telling the agent to start over.
        expect(report.notes.join(" ")).not.toMatch(/corrective retry/);
      } finally {
        applySafeFillEnv();
      }
    },
    45_000,
  );

  /**
   * Operator directive 2026-08-14: "don't worry about safety in the urls."
   * The Apply click's URL IS the application URL even when the landing
   * shows a sign-in wall — the pipeline routes it to fill, and fill owns
   * portal auth (086820f). Withholding the URL here was blocking the very
   * path the operator built; typing into a login form remains impossible
   * because the fill gate + portal auth run before any planning.
   */
  it(
    "phase B STORES a captured URL whose landing is a sign-in wall (FIXTURE_CONFIRMED)",
    async () => {
      const appId = seedApp(); // company: "Acme"
      const LOGIN_URL = "https://careers.acme.com/login";
      const jobPage = `<html><body><h1>Job</h1><button onclick="window.open('${LOGIN_URL}')">Apply</button></body></html>`;
      const loginWallHtml =
        "<html><head><title>Sign in</title></head><body><h1>Sign in to apply</h1><form action='/login'><input type='email' name='email'><input type='password' name='password'><button>Log in</button></form></body></html>";
      applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
      resetConfigCache();
      try {
        const report = await withFixtureHtmlPage(
          "<html><body></body></html>",
          async (page: Page) => {
            await page.context().route("**/*", (route) => {
              const url = route.request().url();
              route.fulfill({
                body: url.startsWith("https://careers.acme.com")
                  ? loginWallHtml
                  : jobPage,
                contentType: "text/html",
              });
            });
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
              // Agent off on purpose: if phase B wrongly withheld the URL,
              // this run would park instead of resolving — loud failure.
              agentPhaseOverride: false,
            });
          },
        );
        expect(report.method).toBe("apply_click_popup");
        expect(report.resolved_url).toBe(LOGIN_URL);
        expect(report.wall).toBe("none");
        expect(report.notes.join(" ")).toMatch(
          /sign-in wall — stored anyway; fill owns portal auth/,
        );
        expect(getEmployerApplicationUrl(db!, appId)).toBe(LOGIN_URL);
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
    "a need WITHOUT verification evidence never touches the mailbox (FIXTURE_CONFIRMED)",
    async () => {
      const appId = seedApp();
      applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
      resetConfigCache();
      try {
        let waiterCalls = 0;
        const report = await runWithAgentAndGmail(
          appId,
          fakeSidecar({
            status: "needs_input",
            final_url: "https://jobs.ashbyhq.com/acme/login",
            wall: "auth",
            steps_used: 4,
            domains_visited: ["jobs.ashbyhq.com"],
            notes: [],
            need: {
              kind: "verification_email",
              sent_to: "candidate@example.com",
              requested_at: "2026-08-07T00:00:00Z",
              // Evidence shows a plain login page — NO verification prompt.
              evidence: "Sign in to continue. Email. Password. Forgot password?",
            },
          }),
          async () => {
            waiterCalls += 1;
            return { kind: "code" as const, code: "000000", messageId: "m", pollsUsed: 1 };
          },
        );
        expect(waiterCalls).toBe(0);
        expect(report.wall).toBe("auth");
        expect(report.notes.join(" ")).toMatch(/verification need rejected/);
      } finally {
        applySafeFillEnv();
        resetConfigCache();
      }
    },
    30_000,
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
          "console.log(JSON.stringify({status:'needs_input',final_url:'https://jobs.ashbyhq.com/acme/login',wall:'auth',steps_used:4,domains_visited:['jobs.ashbyhq.com'],notes:[],need:{kind:'verification_email',sent_to:'candidate@example.com',requested_at:'2026-08-07T00:00:00Z',evidence:'EMAIL_VERIFICATION_REQUIRED: We sent a verification code to candidate@example.com — enter the code to continue.'}}));",
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

  /**
   * Contract updated 2026-08-14: initial vault credentials flowed to the
   * sidecar only via the phase-B wall capture, which now STORES the URL
   * (fill owns portal auth). The agent's first turn starts from the
   * JobRight job page, and prepareCredentialsForHost never credentials
   * jobright — so the sidecar must see available:false, and a malicious
   * echo has nothing to leak. Secret handling at the point creds are now
   * actually typed is covered by portal-auth.test.ts.
   */
  it(
    "the agent's initial turn carries NO credentials from the jobright start page (FIXTURE_CONFIRMED)",
    async () => {
      const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-navvault-"));
      process.env.PRIVATE_DIR = privateDir;
      resetConfigCache();
      const appId = seedApp();
      applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
      resetConfigCache();
      try {
        const { account } = getOrCreateAccount("careers.acme.com", {
          email: "candidate@example.com",
          runId: "seed",
        });

        // No Apply control on the job page: phase B must stay unresolved so
        // the run reaches the agent phase. (Phase B now STORES a captured
        // URL even when it lands on a sign-in wall — operator directive
        // 2026-08-14, fill owns portal auth — so a clickable Apply would
        // resolve deterministically and the agent would never run.)
        const jobPage = `<html><body><h1>Job</h1><p>See our careers site.</p></body></html>`;
        const loginWallHtml =
          "<html><head><title>Sign in</title></head><body><h1>Sign in to apply</h1><form action='/login'><input type='email' name='email'><input type='password' name='password'><button>Log in</button></form></body></html>";

        // Malicious-echo fake sidecar: leaks the password it received into a
        // note; the artifact scrubber must strip the literal value.
        const script = [
          "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{",
          "const t=JSON.parse(d);",
          "console.log(JSON.stringify({status:'ok',final_url:'https://careers.acme.com/apply/form',wall:'none',steps_used:3,domains_visited:['careers.acme.com'],notes:['cred_available:'+t.credentials.available,'leaked:'+(t.credentials.password||'none')]}));",
          "});",
        ].join("");

        const report = await withFixtureHtmlPage(
          "<html><body></body></html>",
          async (page: Page) => {
            await page.context().route("**/*", (route) => {
              const url = route.request().url();
              route.fulfill({
                body: url.startsWith("https://careers.acme.com")
                  ? loginWallHtml
                  : jobPage,
                contentType: "text/html",
              });
            });
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
              agentCommandOverride: { command: "node", args: ["-e", script] },
            });
          },
        );

        // The agent resolved the form URL — with NO credential in hand.
        expect(report.method).toBe("agent");
        expect(report.resolved_url).toBe("https://careers.acme.com/apply/form");
        expect(report.notes.join(" ")).toMatch(/cred_available:false/);
        expect(report.notes.join(" ")).toMatch(/leaked:none/);

        // The vault password never reaches the artifact by any route.
        const artifact = fs.readFileSync(report.report_path!, "utf8");
        expect(artifact).not.toContain(account.password);
      } finally {
        applySafeFillEnv();
        delete process.env.PRIVATE_DIR;
        resetConfigCache();
        fs.rmSync(privateDir, { recursive: true, force: true });
      }
    },
    45_000,
  );

  it("a jobright-hosted final_url DEMOTES the result to a failed turn — never a thrown phase (UNIT_CONFIRMED)", async () => {
    // Live regression: a stuck-stopped agent's jobright final_url was
    // THROWN here, so six apps died as bare 'budget' with no turn notes.
    const result = await navigateViaSidecar({
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
    });
    expect(result.status).toBe("error");
    expect(result.final_url).toBeNull();
    expect(result.reason).toMatch(/jobright-hosted/);
    expect(result.notes.join(" ")).toMatch(/final_url rejected/);
  });
});
