import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveCommittedFixture,
  sanitizeCaptureBundle,
  writeCaptureBundle,
  type CaptureBundle,
} from "../../src/recorder/captureWriter.js";
import {
  JOBRIGHT_WORKFLOWS,
  parseWorkflow,
  captureRunDir,
} from "../../src/recorder/workflows.js";
import { listRecorderWorkflows } from "../../src/recorder/recordFlow.js";
import { sanitizeHtml } from "../../src/recorder/sanitize.js";

function sampleBundle(rootOverrides?: Partial<CaptureBundle>): CaptureBundle {
  return {
    workflow: "job-feed",
    runId: "test-run",
    capturedAt: "2026-07-18T00:00:00.000Z",
    url: "https://jobright.ai/jobs?email=user@example.com",
    title: "Feed user@example.com",
    domHtml:
      '<html><body><a href="/x">Apply</a><script>token="secret"</script><input value="ssn"></body></html>',
    a11yText: "button \"Apply\" email user@example.com",
    labels: [{ tag: "a", role: null, text: "Apply", href: "https://x.test/a" }],
    iframes: [{ src: "https://x.test/frame", name: null, title: null, index: 0 }],
    network: [
      {
        url: "https://api.example.com",
        headers: { Authorization: "Bearer abc", Accept: "application/json" },
        body: "secret",
      },
    ],
    pages: [{ url: "https://jobright.ai/jobs", title: "Jobs" }],
    downloads: [{ url: "https://cdn.example/r.pdf", suggestedFilename: "resume.pdf" }],
    routeLog: [
      {
        at: "2026-07-18T00:00:00.000Z",
        url: "https://jobright.ai/jobs",
        kind: "goto",
      },
    ],
    screenshotPng: Buffer.from("89504e470d0a1a0a", "hex"),
    ...rootOverrides,
  };
}

describe("recorder workflows", () => {
  it("lists seven workflows", () => {
    expect(listRecorderWorkflows()).toEqual([...JOBRIGHT_WORKFLOWS]);
    expect(JOBRIGHT_WORKFLOWS).toHaveLength(7);
    expect(parseWorkflow("email-reveal")).toBe("email-reveal");
    expect(() => parseWorkflow("nope")).toThrow();
  });
});

describe("capture writer", () => {
  it("sanitizes emails tokens and auth headers before write", () => {
    const sanitized = sanitizeCaptureBundle(sampleBundle());
    expect(sanitized.url).not.toContain("user@example.com");
    expect(sanitized.domHtml).not.toContain("secret");
    expect(sanitized.domHtml).toContain("[REDACTED]");
    expect(sanitized.network[0]?.["headers"]).toMatchObject({
      Authorization: "[REDACTED]",
      Accept: "application/json",
    });
  });

  it("tolerates missing arrays without throwing", () => {
    const broken = sampleBundle();
    // Simulate evaluate serialization failure
    (broken as { labels: unknown }).labels = undefined;
    (broken as { iframes: unknown }).iframes = undefined;
    expect(() => sanitizeCaptureBundle(broken)).not.toThrow();
    expect(sanitizeCaptureBundle(broken).labels).toEqual([]);
  });

  it("writes capture directory with required files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-cap-"));
    const written = writeCaptureBundle(sampleBundle(), root);
    expect(written.dir).toBe(captureRunDir("job-feed", "test-run", root));
    expect(fs.existsSync(path.join(written.dir, "meta.json"))).toBe(true);
    expect(fs.existsSync(path.join(written.dir, "dom.sanitized.html"))).toBe(true);
    expect(fs.existsSync(path.join(written.dir, "screenshot.png"))).toBe(true);
    expect(fs.existsSync(path.join(written.dir, "labels.json"))).toBe(true);
    expect(fs.existsSync(path.join(written.dir, "network.sanitized.json"))).toBe(true);
    const dom = fs.readFileSync(path.join(written.dir, "dom.sanitized.html"), "utf8");
    expect(dom).toBe(sanitizeHtml(sampleBundle().domHtml));

    const fixturesRoot = path.join(root, "derived");
    const derived = deriveCommittedFixture({
      workflow: "job-feed",
      captureDir: written.dir,
      fixturesRoot,
    });
    expect(fs.existsSync(path.join(derived.outDir, "dom.sanitized.html"))).toBe(true);
  });
});
