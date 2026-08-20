import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  resolveLiveFillResumePath,
  runAtsLiveFill,
} from "../../src/applications/atsLiveFill.js";
import { ATS_BINDINGS } from "../../src/applications/atsBindings.js";
import { parsePublicProfile } from "../../src/candidate/publicProfile.js";
import {
  applyControlledFillEnv,
  applyFixtureFillEnv,
  applySafeFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";

const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures", "ats");

function fixtureHtml(name: string): string {
  return fs.readFileSync(
    path.join(FIXTURE_DIR, name, "dom.sanitized.html"),
    "utf8",
  );
}

const LEVER_URL =
  "https://jobs.lever.co/acme/a1b2c3d4-e5f6-7890-abcd-ef1234567890/apply";
const ASHBY_URL =
  "https://jobs.ashbyhq.com/acme/9b1e0c2a-1234-4abc-8def-1234567890ab/application";

const PROFILE = parsePublicProfile({
  legal_name: { first: "Ada", last: "Lovelace" },
  email: "ada@example.com",
  phone: "555-0100",
});

describe("resolveLiveFillResumePath (UNIT_CONFIRMED)", () => {
  const defaultPath = "private/candidate/resumes/default.pdf";

  it("honors --resume on any host", () => {
    const r = resolveLiveFillResumePath({
      url: "https://jobs.lever.co/acme/apply",
      explicitResumePath: "C:\\tmp\\cv.pdf",
      defaultResumePath: defaultPath,
      fileExists: () => true,
    });
    expect(r).toEqual({ path: "C:\\tmp\\cv.pdf", source: "flag" });
  });

  it("never silently attaches a resume on an employer host", () => {
    expect(
      resolveLiveFillResumePath({
        url: "https://jobs.lever.co/acme/apply",
        defaultResumePath: defaultPath,
        fileExists: () => true,
      }),
    ).toBeNull();
  });

  it("falls back to DEFAULT_RESUME_PATH on loopback when the file exists", () => {
    const r = resolveLiveFillResumePath({
      url: "http://localhost:4599/gauntlet",
      defaultResumePath: defaultPath,
      fileExists: (p) => p === defaultPath,
    });
    expect(r).toEqual({ path: defaultPath, source: "sandbox_default" });
  });

  it("stays skipped on loopback when the default file is missing", () => {
    expect(
      resolveLiveFillResumePath({
        url: "http://localhost:4599/gauntlet",
        defaultResumePath: defaultPath,
        fileExists: () => false,
      }),
    ).toBeNull();
  });
});

describe("runAtsLiveFill (W5)", () => {
  useIsolatedFillEnv("safe");

  beforeEach(() => {
    applySafeFillEnv();
  });

  it("refuses a URL its binding does not own, before any page (UNIT_CONFIRMED)", async () => {
    const report = await runAtsLiveFill({
      binding: ATS_BINDINGS.lever,
      url: ASHBY_URL,
      execute: false,
    });
    expect(report.mode).toBe("refused");
    expect(report.gate.failure_code).toBe("ATS_MISMATCH");
  });

  it("refuses a URL another adapter claims — binding mismatch, not silence (UNIT_CONFIRMED)", async () => {
    // careers.example.com is now claimed by the generic adapter (no flag),
    // so running it under the LEVER binding is a mismatch, still refused
    // before any mutation.
    const report = await runAtsLiveFill({
      binding: ATS_BINDINGS.lever,
      url: "https://careers.example.com/apply/1",
      execute: false,
    });
    expect(report.mode).toBe("refused");
    expect(report.gate.failure_code).toBe("ATS_MISMATCH");
  });

  it(
    "refuses without mutation when no application form is on the page (FIXTURE_CONFIRMED)",
    async () => {
      const report = await runAtsLiveFill({
        binding: ATS_BINDINGS.lever,
        url: LEVER_URL,
        execute: true,
        fixtureHtml: "<html><body><h1>Position closed</h1></body></html>",
      });
      expect(report.mode).toBe("refused");
      expect(report.gate.failure_code).toBe("UNKNOWN_LANDING");
      expect(report.gate.page_class).toBe("unknown");
      expect(report.fill).toBeNull();
      expect(report.validation_level).toBe("UNVERIFIED");
    },
    45_000,
  );

  it(
    "plan_only run builds the composed plan without mutating (FIXTURE_CONFIRMED)",
    async () => {
      const report = await runAtsLiveFill({
        binding: ATS_BINDINGS.lever,
        url: LEVER_URL,
        execute: false,
        profile: PROFILE,
        fixtureHtml: fixtureHtml("lever"),
      });
      expect(report.mode).toBe("plan_only");
      expect(report.gate.ok).toBe(true);
      expect(report.plan_summary!.fillable_count).toBeGreaterThanOrEqual(3);
      expect(report.fill).toBeNull();
      expect(report.submit_attempted).toBe(false);
      // Fixture-served page: the level must be demoted, never a live claim.
      expect(report.validation_level).toBe("UNVERIFIED");
      expect(report.notes.join(" ")).toMatch(/not live evidence/);
      expect(report.report_path && fs.existsSync(report.report_path)).toBe(true);
    },
    45_000,
  );

  it(
    "execute refuses under safe flags before any field mutation (FIXTURE_CONFIRMED)",
    async () => {
      await expect(
        runAtsLiveFill({
          binding: ATS_BINDINGS.ashby,
          url: ASHBY_URL,
          execute: true,
          profile: PROFILE,
          fixtureHtml: fixtureHtml("ashby"),
        }),
      ).rejects.toThrow(/FORM_FILL_ENABLED|DRY_RUN/);
    },
    45_000,
  );

  it(
    "refuses --submit on a non-loopback employer URL (FIXTURE_CONFIRMED)",
    async () => {
      applyFixtureFillEnv();
      const report = await runAtsLiveFill({
        binding: ATS_BINDINGS.lever,
        url: LEVER_URL,
        execute: true,
        submit: true,
        profile: PROFILE,
        fixtureHtml: fixtureHtml("lever"),
        confirmSubmission: async () => true,
      });
      expect(report.submit_attempted).toBe(false);
      expect(report.submit?.outcome).toBe("refused");
      expect(report.submit?.clicked).toBe(false);
      expect(report.notes.join(" ")).toMatch(/sandbox\/loopback only/);
    },
    45_000,
  );

  it(
    "sandbox submit is refused when SUBMIT_ENABLED is off (FIXTURE_CONFIRMED)",
    async () => {
      applyFixtureFillEnv();
      await expect(
        runAtsLiveFill({
          binding: ATS_BINDINGS.generic,
          url: "http://localhost:4599/gauntlet",
          execute: true,
          submit: true,
          profile: PROFILE,
          fixtureHtml: `<!doctype html><html><body>
            <form>
              <label for="first_name">First Name</label>
              <input id="first_name" name="first_name" />
              <button type="submit">Submit application</button>
            </form>
          </body></html>`,
          confirmSubmission: async () => true,
        }),
      ).rejects.toThrow(/SUBMIT_ENABLED/);
    },
    45_000,
  );

  it(
    "sandbox submit withholds the click when a required control is empty (FIXTURE_CONFIRMED)",
    async () => {
      applyControlledFillEnv({
        FORM_FILL_ENABLED: "true",
        DRY_RUN: "false",
        SUBMIT_ENABLED: "true",
        SUBMIT_REQUIRES_LOCAL_CONFIRMATION: "true",
      });
      const report = await runAtsLiveFill({
        binding: ATS_BINDINGS.generic,
        url: "http://localhost:4599/gauntlet",
        execute: true,
        submit: true,
        profile: PROFILE,
        fixtureHtml: `<!doctype html><html><body>
          <form>
            <label for="first_name">First Name</label>
            <input id="first_name" name="first_name" />
            <label for="w_grad">Expected graduation</label>
            <select id="w_grad" name="w_grad" required>
              <option value="">Select...</option>
              <option>Spring 2026</option>
            </select>
            <button type="submit">Submit application</button>
          </form>
        </body></html>`,
        confirmSubmission: async () => true,
      });
      expect(report.submit_attempted).toBe(false);
      expect(report.submit?.outcome).toBe("failed_before_click");
      expect(report.notes.join(" ")).toMatch(/required question/);
    },
    45_000,
  );

  it(
    "sandbox submit clicks and confirms on a loopback form (FIXTURE_CONFIRMED)",
    async () => {
      applyControlledFillEnv({
        FORM_FILL_ENABLED: "true",
        DRY_RUN: "false",
        SUBMIT_ENABLED: "true",
        SUBMIT_REQUIRES_LOCAL_CONFIRMATION: "true",
      });
      const report = await runAtsLiveFill({
        binding: ATS_BINDINGS.generic,
        url: "http://localhost:4599/gauntlet",
        execute: true,
        submit: true,
        profile: PROFILE,
        fixtureHtml: `<!doctype html><html><body>
          <form>
            <label for="first_name">First Name</label>
            <input id="first_name" name="first_name" required />
            <button type="submit">Submit application</button>
          </form>
          <script>
            document.querySelector('form').addEventListener('submit', function (e) {
              e.preventDefault();
              document.body.innerHTML =
                '<h1>Thank you for applying!</h1><p>Your application has been received.</p>';
            });
          </script>
        </body></html>`,
        confirmSubmission: async () => true,
      });
      expect(report.submit_attempted).toBe(true);
      expect(report.submit?.outcome).toBe("confirmed");
      expect(report.submit?.clicked).toBe(true);
      expect(report.submit?.receipt?.submitted).toBe(true);
    },
    45_000,
  );

  it(
    "execute on a posting clicks Apply before refusing NO_APPLICATION_FORM (FIXTURE_CONFIRMED)",
    async () => {
      applyFixtureFillEnv();
      const report = await runAtsLiveFill({
        binding: ATS_BINDINGS.generic,
        url: "http://localhost:4599/portal",
        execute: true,
        profile: PROFILE,
        fixtureHtml: `<!doctype html><html><body>
          <h1>AI Engineer Intern</h1>
          <input placeholder="Search by job title, ID, or keyword" />
          <input placeholder="City, state, or country/region" />
          <button type="button" id="apply">Apply</button>
          <script>
            document.getElementById('apply').addEventListener('click', function () {
              var form = document.createElement('form');
              function add(name, type, labelText) {
                var lab = document.createElement('label');
                lab.htmlFor = name;
                lab.textContent = labelText;
                var inp = document.createElement('input');
                inp.id = name;
                inp.name = name;
                inp.type = type;
                form.appendChild(lab);
                form.appendChild(inp);
              }
              add('first_name', 'text', 'First Name');
              add('email', 'email', 'Email');
              document.body.replaceChildren(form);
            });
          </script>
        </body></html>`,
      });
      expect(report.notes.join(" ")).toMatch(/landed on a posting/);
      expect(report.mode).toBe("executed");
      expect(report.fill).not.toBeNull();
      expect(report.gate.ok).toBe(true);
    },
    45_000,
  );

  it(
    "execute on a posting that reveals a login wall refuses LOGIN_WALL, not the auth form (FIXTURE_CONFIRMED)",
    async () => {
      applyFixtureFillEnv();
      const report = await runAtsLiveFill({
        binding: ATS_BINDINGS.generic,
        url: "http://localhost:4599/portal",
        execute: true,
        profile: PROFILE,
        fixtureHtml: `<!doctype html><html><body>
          <h1>AI Engineer Intern</h1>
          <input placeholder="Search by job title, ID, or keyword" />
          <button type="button" id="apply">Apply</button>
          <script>
            document.getElementById('apply').addEventListener('click', function () {
              var h1 = document.createElement('h1');
              h1.textContent = 'Sign In';
              var form = document.createElement('form');
              form.setAttribute('action', '/login');
              function add(name, type, labelText) {
                var lab = document.createElement('label');
                lab.textContent = labelText;
                var inp = document.createElement('input');
                inp.name = name;
                inp.type = type;
                form.appendChild(lab);
                form.appendChild(inp);
              }
              add('email', 'email', 'Email');
              add('password', 'password', 'Password');
              var btn = document.createElement('button');
              btn.textContent = 'Sign In';
              form.appendChild(btn);
              document.body.replaceChildren(h1, form);
            });
          </script>
        </body></html>`,
      });
      expect(report.notes.join(" ")).toMatch(/landed on a posting/);
      expect(report.mode).toBe("refused");
      expect(report.gate.failure_code).toBe("LOGIN_WALL");
      expect(report.fill).toBeNull();
      expect(report.notes.join(" ")).toMatch(/login wall/);
    },
    45_000,
  );

  it(
    "plan_only on a posting still refuses — Apply is execute-only (FIXTURE_CONFIRMED)",
    async () => {
      const report = await runAtsLiveFill({
        binding: ATS_BINDINGS.generic,
        url: "http://localhost:4599/portal",
        execute: false,
        profile: PROFILE,
        fixtureHtml: `<!doctype html><html><body>
          <h1>AI Engineer Intern</h1>
          <input placeholder="Search by job title, ID, or keyword" />
          <button type="button">Apply</button>
        </body></html>`,
      });
      expect(report.mode).toBe("refused");
      expect(report.gate.failure_code).toBe("NO_APPLICATION_FORM");
      expect(report.fill).toBeNull();
      expect(report.notes.join(" ")).not.toMatch(/landed on a posting/);
    },
    45_000,
  );

  it(
    "execute on a password-only wall refuses LOGIN_WALL, not NO_APPLICATION_FORM (FIXTURE_CONFIRMED)",
    async () => {
      applyFixtureFillEnv();
      const report = await runAtsLiveFill({
        binding: ATS_BINDINGS.generic,
        url: "http://localhost:4599/portal/auth",
        execute: true,
        profile: PROFILE,
        fixtureHtml: `<!doctype html><html><body>
          <form action="/session">
            <input name="username" />
            <input type="password" name="password" />
            <button type="submit">Continue</button>
          </form>
        </body></html>`,
      });
      expect(report.mode).toBe("refused");
      expect(report.gate.page_class).toBe("auth");
      expect(report.gate.failure_code).toBe("LOGIN_WALL");
      expect(report.fill).toBeNull();
      expect(report.notes.join(" ")).toMatch(/login wall/i);
    },
    45_000,
  );

  it(
    "a resume on disk is not an upload miss when the form has no file input (FIXTURE_CONFIRMED)",
    async () => {
      applyFixtureFillEnv();
      const report = await runAtsLiveFill({
        binding: ATS_BINDINGS.generic,
        url: "http://localhost:4599/portal",
        execute: true,
        profile: PROFILE,
        resumePath: path.join(
          FIXTURE_DIR,
          "greenhouse",
          "sample-resume.pdf",
        ),
        fixtureHtml: `<!doctype html><html><body>
          <form>
            <label for="first_name">First Name</label>
            <input id="first_name" name="first_name" />
            <button type="submit">Submit application</button>
          </form>
        </body></html>`,
      });
      expect(report.mode).toBe("executed");
      expect(report.verify?.passed).toBe(true);
      expect(report.uploads).toBeNull();
      expect(report.notes.join(" ")).toMatch(/no file input — not an upload miss/);
      expect(report.operator_brief?.items.some((i) => i.kind === "upload_failed")).not.toBe(
        true,
      );
    },
    45_000,
  );

  it(
    "a pipeline-invoked fill records application_id + source pipeline (X4a corpus-join fix)",
    async () => {
      applyFixtureFillEnv();
      const os = await import("node:os");
      const { randomUUID } = await import("node:crypto");
      const { openDatabase, migrate, closeDatabase } = await import(
        "../../src/storage/db/client.js"
      );
      const dbPath = path.join(os.tmpdir(), `jaa-x4a-${randomUUID()}.sqlite`);
      const db = openDatabase(dbPath);
      try {
        migrate(db);
        const applicationId = randomUUID();
        const report = await runAtsLiveFill({
          binding: ATS_BINDINGS.generic,
          url: "http://localhost:4599/portal",
          execute: true,
          profile: PROFILE,
          capture: { db, applicationId },
          fixtureHtml: `<!doctype html><html><body>
            <form>
              <label for="first_name">First Name</label>
              <input id="first_name" name="first_name" />
              <button type="submit">Submit application</button>
            </form>
          </body></html>`,
        });
        expect(report.mode).toBe("executed");
        const row = db
          .prepare(
            `SELECT source, application_id FROM fill_runs ORDER BY created_at DESC LIMIT 1`,
          )
          .get() as { source: string; application_id: string | null };
        expect(row.source).toBe("pipeline");
        expect(row.application_id).toBe(applicationId);
      } finally {
        closeDatabase(db);
        for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
          if (fs.existsSync(p)) fs.unlinkSync(p);
        }
      }
    },
    45_000,
  );
});
