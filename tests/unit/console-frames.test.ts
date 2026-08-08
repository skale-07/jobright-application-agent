import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createStdioConfirm,
  parseFrame,
  serializeFrame,
} from "../../src/console/frames.js";
import type { SubmitConfirmationSummary } from "../../src/applications/submitConfirmation.js";

const SUMMARY: SubmitConfirmationSummary = {
  application_id: "app-1",
  company: "Acme",
  role: "SWE",
  url: "https://jobs.lever.co/acme/x/apply",
  attempt: 1,
  resume_sha256: "f".repeat(64),
  resume_size_bytes: 100,
  plan: { fillable_count: 3, skipped_count: 1, review_required_count: 0 },
};

function harness(timeoutMs = 2000) {
  const input = new PassThrough();
  const output = new PassThrough();
  const confirm = createStdioConfirm({ input, output, timeoutMs });
  const request = new Promise<{ confirmation_id: string }>((resolve) => {
    let buf = "";
    output.on("data", (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) resolve(JSON.parse(buf.slice(0, nl)) as { confirmation_id: string });
    });
  });
  return { input, output, confirm, request };
}

describe("stdio confirmation transport (UNIT_CONFIRMED)", () => {
  it("parseFrame lifts control frames and leaves log lines alone", () => {
    expect(parseFrame(`{"jaa_frame":"hello","kind":"nav","pid":1,"gates":{}}`)).toMatchObject({
      jaa_frame: "hello",
    });
    expect(parseFrame(`{"timestamp":"t","level":"info","message":"x"}`)).toBeNull();
    expect(parseFrame("plain text with jaa_frame word")).toBeNull();
    expect(parseFrame(`{"jaa_frame": 42}`)).toBeNull();
    const roundtrip = parseFrame(serializeFrame({ jaa_frame: "report", report: { a: 1 } }).trim());
    expect(roundtrip).toEqual({ jaa_frame: "report", report: { a: 1 } });
  });

  it("resolves true on a matching accept", async () => {
    const h = harness();
    const promise = h.confirm(SUMMARY);
    const req = await h.request;
    h.input.write(
      `${JSON.stringify({ jaa_frame: "confirm_response", confirmation_id: req.confirmation_id, accept: true })}\n`,
    );
    await expect(promise).resolves.toBe(true);
  });

  it("resolves false on decline", async () => {
    const h = harness();
    const promise = h.confirm(SUMMARY);
    const req = await h.request;
    h.input.write(
      `${JSON.stringify({ jaa_frame: "confirm_response", confirmation_id: req.confirmation_id, accept: false })}\n`,
    );
    await expect(promise).resolves.toBe(false);
  });

  it("ignores stale ids and malformed lines, then times out to false", async () => {
    const h = harness(300);
    const promise = h.confirm(SUMMARY);
    await h.request;
    h.input.write("not json at all\n");
    h.input.write(
      `${JSON.stringify({ jaa_frame: "confirm_response", confirmation_id: "stale-id", accept: true })}\n`,
    );
    h.input.write(`${JSON.stringify({ jaa_frame: "other" })}\n`);
    // A stale accept must NEVER approve — only the timeout decline fires.
    await expect(promise).resolves.toBe(false);
  });

  it("stream EOF fails closed", async () => {
    const h = harness();
    const promise = h.confirm(SUMMARY);
    await h.request;
    h.input.end();
    await expect(promise).resolves.toBe(false);
  });

  it("accept arriving with a missing accept field is a decline", async () => {
    const h = harness(300);
    const promise = h.confirm(SUMMARY);
    const req = await h.request;
    h.input.write(
      `${JSON.stringify({ jaa_frame: "confirm_response", confirmation_id: req.confirmation_id })}\n`,
    );
    await expect(promise).resolves.toBe(false);
  });
});
