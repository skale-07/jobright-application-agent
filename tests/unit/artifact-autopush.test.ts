import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { autopushArtifacts } from "../../src/automation/artifactAutopush.js";

/**
 * Stage-1 courier leg against a REAL local git pair (work repo + bare
 * remote): artifact-only staging, push, idempotence, and the
 * never-sweep-unrelated-changes rule. UNIT_CONFIRMED.
 */
describe("artifact autopush (UNIT_CONFIRMED)", () => {
  let dir: string;
  let work: string;
  let bare: string;

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-autopush-"));
    bare = path.join(dir, "remote.git");
    work = path.join(dir, "work");
    execFileSync("git", ["init", "--bare", bare]);
    execFileSync("git", ["init", "-b", "master", work]);
    git(work, "config", "user.email", "t@example.com");
    git(work, "config", "user.name", "t");
    git(work, "remote", "add", "origin", bare);
    fs.writeFileSync(path.join(work, "README.md"), "seed\n");
    git(work, "add", "-A");
    git(work, "commit", "-m", "seed");
    git(work, "push", "origin", "master");
    fs.mkdirSync(path.join(work, "artifacts", "navigation"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("pushes new artifacts, is idempotent, and never sweeps non-artifact changes", async () => {
    fs.writeFileSync(
      path.join(work, "artifacts", "navigation", "report.json"),
      `{"run":"nav-1"}`,
    );
    // An unrelated staged code change must NOT ride along.
    fs.writeFileSync(path.join(work, "code.ts"), "export const x = 1;\n");
    git(work, "add", "code.ts");

    const r = await autopushArtifacts({ armRunId: "12345678-abcd", cwd: work });
    expect(r.pushed).toBe(true);
    expect(r.commit).not.toBeNull();

    // The bare remote received exactly the artifact file.
    const remoteFiles = git(bare, "ls-tree", "-r", "--name-only", "master");
    expect(remoteFiles).toContain("artifacts/navigation/report.json");
    expect(remoteFiles).not.toContain("code.ts");
    const msg = git(work, "log", "-1", "--format=%s");
    expect(msg).toBe("art: automation session 12345678 (autopush)");
    // The unrelated change is still present and unstaged-or-staged locally,
    // not committed.
    expect(fs.existsSync(path.join(work, "code.ts"))).toBe(true);
    expect(git(work, "log", "-1", "--format=%s")).not.toContain("code");

    // Second run with nothing new: clean no-op.
    const r2 = await autopushArtifacts({ armRunId: "12345678-abcd", cwd: work });
    expect(r2.pushed).toBe(false);
    expect(r2.notes.join(" ")).toMatch(/nothing new/);
  });

  it("push failure degrades to a note, never a throw", async () => {
    fs.writeFileSync(
      path.join(work, "artifacts", "navigation", "r2.json"),
      "{}",
    );
    git(work, "remote", "set-url", "origin", path.join(dir, "missing.git"));
    const r = await autopushArtifacts({ armRunId: "deadbeef-1", cwd: work });
    expect(r.pushed).toBe(false);
    expect(r.commit).not.toBeNull(); // local commit exists — data not lost
    expect(r.notes.join(" ")).toMatch(/push failed after retries/);
  }, 20_000);
});
