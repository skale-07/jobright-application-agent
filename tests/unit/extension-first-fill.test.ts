import { describe, expect, it } from "vitest";
import path from "node:path";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import { attemptExtensionAutofill } from "../../src/jobright/extension/autofill.js";
import { resolveFillStrategy } from "../../src/applications/fillStrategy.js";
import { runAtsLiveFill } from "../../src/applications/atsLiveFill.js";
import { ATS_BINDINGS } from "../../src/applications/atsBindings.js";
import { parsePublicProfile } from "../../src/candidate/publicProfile.js";
import {
  applyControlledFillEnv,
  applyFixtureFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";

/**
 * X2/X3 extension-first fill. The "extension" here is fixture JS wired to
 * a trigger button — FIXTURE_CONFIRMED for activation detection, gap
 * restriction, and strategy resolution; the real JobRight extension stays
 * UNVERIFIED until an operator run.
 */
const PROFILE = parsePublicProfile({
  legal_name: { first: "Ada", last: "Lovelace" },
  email: "ada@example.com",
  phone: "555-0100",
});

// Trigger fills first name + email; leaves phone for the native gap-fill.
const EXT_FORM = `<!doctype html><html><body>
  <button id="jr-fill" type="button" onclick="
    document.getElementById('full_name').value='Ada Lovelace';
    document.getElementById('email').value='ada@example.com';
  ">Autofill with JobRight</button>
  <form>
    <label for="full_name">Full Name</label><input id="full_name" name="full_name" />
    <label for="email">Email</label><input id="email" name="email" type="email" />
    <label for="phone">Phone</label><input id="phone" name="phone" type="tel" />
    <button type="submit">Submit application</button>
  </form>
</body></html>`;

describe("extension activation (FIXTURE_CONFIRMED)", () => {
  it("empty trigger registry never clicks — attempted:false with promotion hint", async () => {
    await withFixtureHtmlPage(EXT_FORM, async (page) => {
      const r = await attemptExtensionAutofill(page, { triggerSelectors: [] });
      expect(r.attempted).toBe(false);
      expect(r.activated).toBe(false);
      expect(r.notes.join(" ")).toMatch(/ext-capture/);
    });
  }, 45_000);

  it("a working trigger is detected via the value-fingerprint settle", async () => {
    await withFixtureHtmlPage(EXT_FORM, async (page) => {
      const r = await attemptExtensionAutofill(page, {
        triggerSelectors: ["#jr-fill"],
        settleMs: 6_000,
        pollMs: 300,
      });
      expect(r.attempted).toBe(true);
      expect(r.activated).toBe(true);
      expect(r.changed_fields).toBe(2);
    });
  }, 45_000);

  it("a dead trigger reports activated:false after the bounded settle", async () => {
    await withFixtureHtmlPage(
      `<!doctype html><html><body>
        <button id="dead" type="button">Autofill</button>
        <form><input id="a" /></form>
      </body></html>`,
      async (page) => {
        const r = await attemptExtensionAutofill(page, {
          triggerSelectors: ["#dead"],
          settleMs: 1_500,
          pollMs: 300,
        });
        expect(r.attempted).toBe(true);
        expect(r.activated).toBe(false);
      },
    );
  }, 45_000);
});

describe("fill strategy resolution (UNIT_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  const seams = {
    fetchTargets: async () => [
      {
        type: "service_worker",
        url: "chrome-extension://abc/sw.js",
        title: "JobRight",
      },
    ],
  };

  it("flag off → NATIVE_ONLY regardless of everything else", async () => {
    const r = await resolveFillStrategy({
      fixture: false,
      submitHeld: false,
      seams,
      triggerSelectors: ["#jr-fill"],
    });
    expect(r.strategy).toBe("NATIVE_ONLY");
    expect(r.notes.join(" ")).toMatch(/JOBRIGHT_AUTOFILL_ENABLED/);
  });

  it("fixture and submit-held runs never take the extension path", async () => {
    applyControlledFillEnv({ JOBRIGHT_AUTOFILL_ENABLED: "true" });
    for (const input of [
      { fixture: true, submitHeld: false },
      { fixture: false, submitHeld: true },
    ]) {
      const r = await resolveFillStrategy({
        ...input,
        seams,
        triggerSelectors: ["#jr-fill"],
      });
      expect(r.strategy).toBe("NATIVE_ONLY");
    }
  });

  it("unpromoted trigger registry → NATIVE_ONLY (fail closed)", async () => {
    applyControlledFillEnv({ JOBRIGHT_AUTOFILL_ENABLED: "true" });
    const r = await resolveFillStrategy({
      fixture: false,
      submitHeld: false,
      seams,
    });
    expect(r.strategy).toBe("NATIVE_ONLY");
    expect(r.notes.join(" ")).toMatch(/ext-capture/);
  });

  it("preflight unknown → NATIVE_ONLY; all preconditions met → EXTENSION_FIRST", async () => {
    applyControlledFillEnv({ JOBRIGHT_AUTOFILL_ENABLED: "true" });
    const unknown = await resolveFillStrategy({
      fixture: false,
      submitHeld: false,
      seams: { fetchTargets: async () => [] },
      triggerSelectors: ["#jr-fill"],
    });
    expect(unknown.strategy).toBe("NATIVE_ONLY");

    const go = await resolveFillStrategy({
      fixture: false,
      submitHeld: false,
      seams,
      triggerSelectors: ["#jr-fill"],
    });
    expect(go.strategy).toBe("EXTENSION_FIRST");
  });
});

describe("extension-first live fill with native gap-fill (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  it("extension-satisfied answers are left alone; the gap fills natively; whole-form verify passes", async () => {
    applyFixtureFillEnv();
    applyControlledFillEnv({ JOBRIGHT_AUTOFILL_ENABLED: "true" });
    const report = await runAtsLiveFill({
      binding: ATS_BINDINGS.generic,
      url: "http://localhost:4599/portal",
      execute: true,
      extensionFirst: true,
      extensionTriggerSelectors: ["#jr-fill"],
      profile: PROFILE,
      fixtureHtml: EXT_FORM,
    });
    expect(report.mode).toBe("executed");
    expect(report.extension?.attempted).toBe(true);
    expect(report.extension?.activated).toBe(true);
    expect(report.extension?.satisfied_answers.length).toBeGreaterThanOrEqual(1);
    // The gap-fill only typed what the extension left empty.
    expect(report.verify?.passed).toBe(true);
    const satisfied = new Set(report.extension?.satisfied_answers ?? []);
    for (const filled of report.fill?.filled ?? []) {
      expect(satisfied.has(filled)).toBe(false);
    }
  }, 60_000);

  it("X4: the run records strategy, trace artifact, and per-field filled_by attribution", async () => {
    applyFixtureFillEnv();
    applyControlledFillEnv({ JOBRIGHT_AUTOFILL_ENABLED: "true" });
    const fs = await import("node:fs");
    const os = await import("node:os");
    const { randomUUID } = await import("node:crypto");
    const { openDatabase, migrate, closeDatabase } = await import(
      "../../src/storage/db/client.js"
    );
    const { getConfig } = await import("../../src/config/index.js");
    const dbPath = path.join(os.tmpdir(), `jaa-x4-${randomUUID()}.sqlite`);
    const db = openDatabase(dbPath);
    try {
      migrate(db);
      const applicationId = randomUUID();
      await runAtsLiveFill({
        binding: ATS_BINDINGS.generic,
        url: "http://localhost:4599/portal",
        execute: true,
        extensionFirst: true,
        extensionTriggerSelectors: ["#jr-fill"],
        profile: PROFILE,
        capture: { db, applicationId },
        fixtureHtml: EXT_FORM,
      });
      const run = db
        .prepare(
          `SELECT strategy, trace_relpath FROM fill_runs ORDER BY created_at DESC LIMIT 1`,
        )
        .get() as { strategy: string; trace_relpath: string | null };
      expect(run.strategy).toBe("EXTENSION_FIRST");
      expect(run.trace_relpath).toMatch(/fill-trace-\d+\.jsonl$/);

      const tracePath = path.join(
        getConfig().artifactsDir,
        run.trace_relpath!,
      );
      const trace = fs.readFileSync(tracePath, "utf8");
      expect(trace).toContain('"event":"activation"');
      expect(trace).toContain('"event":"verify"');
      // PII rule: classed/identifier data only.
      expect(trace).not.toContain("Ada Lovelace");
      expect(trace).not.toContain("ada@example.com");
      expect(trace).not.toContain("555-0100");

      const byField = db
        .prepare(
          `SELECT canonical_field, filled_by FROM fill_field_outcomes
           WHERE fill_run_id = (SELECT id FROM fill_runs ORDER BY created_at DESC LIMIT 1)`,
        )
        .all() as Array<{ canonical_field: string | null; filled_by: string | null }>;
      const attribution = new Map(
        byField.map((r) => [r.canonical_field, r.filled_by]),
      );
      expect(attribution.get("email")).toBe("extension");
      expect(attribution.get("phone")).toBe("native");
    } finally {
      closeDatabase(db);
      for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
    }
  }, 60_000);

  it("flag off: extensionFirst degrades to a plain native fill", async () => {
    applyFixtureFillEnv();
    const report = await runAtsLiveFill({
      binding: ATS_BINDINGS.generic,
      url: "http://localhost:4599/portal",
      execute: true,
      extensionFirst: true,
      extensionTriggerSelectors: ["#jr-fill"],
      profile: PROFILE,
      fixtureHtml: EXT_FORM,
    });
    expect(report.mode).toBe("executed");
    expect(report.extension).toBeUndefined();
    expect(report.notes.join(" ")).toMatch(/JOBRIGHT_AUTOFILL_ENABLED is off/);
    expect(report.verify?.passed).toBe(true);
  }, 60_000);
});
