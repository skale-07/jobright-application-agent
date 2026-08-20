import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigCache } from "../../src/config/index.js";
import {
  probeCdpTargetsForExtension,
  type ExtensionPreflightReport,
} from "../../src/automation/extensionPreflight.js";
import { assertDebugProfileDir } from "../../src/automation/cdpChrome.js";
import { jobrightExtensionSelectorsV1 } from "../../src/jobright/extension/selectors.js";

/**
 * Extension preflight honesty (X0): the verdict is "present" or
 * "unknown", never a confident absent — MV3 service workers idle out and
 * extension frames are invisible to the DOM probe. UNIT_CONFIRMED via the
 * fetch seam; no test touches a live CDP endpoint.
 */
describe("extension preflight (UNIT_CONFIRMED)", () => {
  let savedId: string | undefined;

  beforeEach(() => {
    savedId = process.env.JOBRIGHT_EXTENSION_ID;
    delete process.env.JOBRIGHT_EXTENSION_ID;
    resetConfigCache();
  });
  afterEach(() => {
    if (savedId === undefined) delete process.env.JOBRIGHT_EXTENSION_ID;
    else process.env.JOBRIGHT_EXTENSION_ID = savedId;
    resetConfigCache();
  });

  const probe = (targets: unknown[] | Error): Promise<ExtensionPreflightReport> =>
    probeCdpTargetsForExtension("http://127.0.0.1:9222", {
      fetchTargets: async () => {
        if (targets instanceof Error) throw targets;
        return targets as Array<{ type?: string; url?: string; title?: string }>;
      },
    });

  it("unreachable CDP → unknown, never absent", async () => {
    const r = await probe(new Error("ECONNREFUSED"));
    expect(r.verdict).toBe("unknown");
    expect(r.cdp_reachable).toBe(false);
    expect(r.notes.join(" ")).toMatch(/unreachable/);
  });

  it("a jobright-titled extension target → present, with evidence", async () => {
    const r = await probe([
      { type: "page", url: "https://boards.greenhouse.io/x", title: "Job" },
      {
        type: "service_worker",
        url: "chrome-extension://abcdefgh/sw.js",
        title: "JobRight — AI Job Search Copilot",
      },
    ]);
    expect(r.verdict).toBe("present");
    expect(r.matched_targets[0]).toMatch(/JobRight/);
  });

  it("no extension targets at all → unknown with the MV3 explanation", async () => {
    const r = await probe([{ type: "page", url: "https://x.test", title: "x" }]);
    expect(r.verdict).toBe("unknown");
    expect(r.cdp_reachable).toBe(true);
    expect(r.notes.join(" ")).toMatch(/MV3|proves nothing/);
  });

  it("JOBRIGHT_EXTENSION_ID pins matching to the exact id", async () => {
    process.env.JOBRIGHT_EXTENSION_ID = "pinnedextid000";
    resetConfigCache();
    const wrong = await probe([
      {
        type: "service_worker",
        url: "chrome-extension://otherid/sw.js",
        title: "JobRight",
      },
    ]);
    expect(wrong.verdict).toBe("unknown");

    const right = await probe([
      {
        type: "service_worker",
        url: "chrome-extension://pinnedextid000/sw.js",
        title: "whatever title",
      },
    ]);
    expect(right.verdict).toBe("present");
  });

  it("the autofill trigger list ships EMPTY until a real capture promotes it", () => {
    // Fail-closed by construction: no trigger selectors ⇒ activation can
    // never blind-click; the fill falls back to the native path.
    expect(jobrightExtensionSelectorsV1.autofillTrigger).toEqual([]);
  });
});

describe("cdpChrome profile guard (UNIT_CONFIRMED)", () => {
  it("accepts only the dedicated jobright-cdp profile dir", () => {
    expect(() =>
      assertDebugProfileDir("/home/op/.dispatch/profiles/jobright-cdp"),
    ).not.toThrow();
    expect(() =>
      assertDebugProfileDir("C:\\dev\\profiles\\jobright-cdp"),
    ).not.toThrow();
  });

  it("refuses everyday-Chrome and degenerate dirs — pkill must never go broad", () => {
    for (const bad of [
      "",
      "   ",
      "/",
      "/home/op",
      "C:\\Users\\op\\AppData\\Local\\Google\\Chrome\\User Data",
      "/home/op/.dispatch/profiles/jobright-cdp/../everyday",
    ]) {
      expect(() => assertDebugProfileDir(bad)).toThrow(/refusing to manage/);
    }
  });
});
