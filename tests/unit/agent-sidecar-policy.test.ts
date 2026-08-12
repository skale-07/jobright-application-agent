import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The nav sidecar's traversal policy lives in Python
 * (agent/jobright_agent/navigate.py) and decides whether a completed agent
 * run is kept or thrown away — the single biggest source of `wall: budget`
 * in the live corpus. These tests drive the real module so the policy is
 * covered by `npm run test` rather than only by live runs.
 *
 * navigate.py's heavy imports (browser_use) are function-local, so the
 * module imports on stdlib alone. Where no interpreter is present the
 * suite skips rather than failing: Python is required to RUN the agent,
 * not to build the TypeScript.
 */
const PY = ["python3", "python"].find((bin) => {
  const probe = spawnSync(bin, ["-c", "print(1)"], { encoding: "utf8" });
  return probe.status === 0;
});

function py(script: string): string {
  const res = spawnSync(
    PY!,
    [
      "-c",
      `import sys; sys.path.insert(0, ${JSON.stringify(path.resolve("agent"))})\n${script}`,
    ],
    { encoding: "utf8" },
  );
  if (res.status !== 0) {
    throw new Error(`python failed: ${res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
}

describe.skipIf(!PY)("nav sidecar traversal policy (UNIT_CONFIRMED)", () => {
  it("matches sibling hostnames inside a known ATS family", () => {
    // Live 2026-08-11: allowlist had boards.greenhouse.io, the agent
    // landed on job-boards.greenhouse.io, and the turn was discarded.
    expect(
      py(
        "from jobright_agent.navigate import _in_allowed\n" +
          "print(_in_allowed('https://job-boards.greenhouse.io/acme/jobs/1', ['boards.greenhouse.io']))",
      ),
    ).toBe("True");
    expect(
      py(
        "from jobright_agent.navigate import _in_allowed\n" +
          "print(_in_allowed('https://acme.wd5.myworkdayjobs.com/en-US/Careers', ['cadence.wd1.myworkdayjobs.com']))",
      ),
    ).toBe("True");
  });

  it("never treats two unrelated employers as siblings", () => {
    expect(
      py(
        "from jobright_agent.navigate import _in_allowed\n" +
          "print(_in_allowed('https://careers.evil.com/x', ['shop.acme.com']))",
      ),
    ).toBe("False");
    expect(
      py(
        "from jobright_agent.navigate import _in_allowed\n" +
          "print(_in_allowed('https://www.ycombinator.com/x', ['jobs.lever.co']))",
      ),
    ).toBe("False");
  });

  it("keeps exact-host and subdomain matching intact", () => {
    expect(
      py(
        "from jobright_agent.navigate import _in_allowed\n" +
          "print(_in_allowed('https://careers.acme.com/x', ['acme.com']), " +
          "_in_allowed('https://jobs.lever.co/x', ['jobs.lever.co']))",
      ),
    ).toBe("True True");
  });

  it("keeps a run whose FINAL url is on-domain, even after an off-domain hop", () => {
    // The live bug: a leftover Cadence tab inside an InterDigital run
    // discarded a result that had reached the right Greenhouse board.
    const script = [
      "from jobright_agent.navigate import judge_traversal",
      "v = judge_traversal([",
      "  'https://jobright.ai/jobs/1',",
      "  'https://cadence.wd1.myworkdayjobs.com/leftover-tab',",
      "  'https://boards.greenhouse.io/acme/jobs/9',",
      "], ['jobright.ai', 'boards.greenhouse.io'])",
      "print(v['final_url_allowed'], v['off_domain_count'], v['final_url'])",
    ].join("\n");
    expect(py(script)).toBe(
      "True 1 https://boards.greenhouse.io/acme/jobs/9",
    );
  });

  it("still refuses a run whose FINAL url is off-domain", () => {
    const script = [
      "from jobright_agent.navigate import judge_traversal",
      "v = judge_traversal([",
      "  'https://boards.greenhouse.io/acme/jobs/9',",
      "  'https://www.ycombinator.com/companies',",
      "], ['boards.greenhouse.io'])",
      "print(v['final_url_allowed'], v['off_domain_count'])",
    ].join("\n");
    expect(py(script)).toBe("False 1");
  });

  it("an empty history is refused, not silently accepted", () => {
    expect(
      py(
        "from jobright_agent.navigate import judge_traversal\n" +
          "v = judge_traversal([], ['boards.greenhouse.io'])\n" +
          "print(v['final_url_allowed'], v['final_url'])",
      ),
    ).toBe("False None");
  });

  it("exposes a fresh-tab opener that tolerates any browser-use API shape", () => {
    // Fix 2: the run must start on its own about:blank tab so the
    // PREVIOUS application's page cannot enter this run's history.
    // A browser object with none of the known methods must not throw.
    const script = [
      "import asyncio",
      "from jobright_agent.navigate import _open_own_tab",
      "class NewTab:",
      "    def __init__(self): self.calls = []",
      "    async def new_tab(self, url=None): self.calls.append(url)",
      "class Legacy:",
      "    def __init__(self): self.calls = []",
      "    async def new_page(self, url=None): self.calls.append(url)",
      "class Nothing: pass",
      "a, b, c = NewTab(), Legacy(), Nothing()",
      "r1 = asyncio.run(_open_own_tab(a))",
      "r2 = asyncio.run(_open_own_tab(b))",
      "r3 = asyncio.run(_open_own_tab(c))",
      "print(r1, a.calls[0], r2, b.calls[0], r3)",
    ].join("\n");
    expect(py(script)).toBe("True about:blank True about:blank False");
  });
});
