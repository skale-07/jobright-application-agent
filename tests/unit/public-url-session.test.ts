import { describe, expect, it } from "vitest";
import { openPublicUrlSession } from "../../src/browser/fixtureSession.js";

describe("openPublicUrlSession (FIXTURE_CONFIRMED)", () => {
  it("hands the caller a page and close() is idempotent", async () => {
    const session = await openPublicUrlSession({ headless: true });
    expect(session.page.isClosed()).toBe(false);
    await session.close();
    expect(session.page.isClosed()).toBe(true);
    await session.close();
  }, 30_000);
});
