import fs from "node:fs";
import path from "node:path";

/**
 * Era stamp for training data: the git short-sha of the code that produced
 * a telemetry row. The nav-agent goal prompt, discovery regexes, and fill
 * tactics all change between commits — corpus rows from different eras are
 * different distributions, and a model trained on unstamped data can't
 * separate them. Read from .git directly (no child process: this runs in
 * hot telemetry paths) and cached for the process lifetime.
 */
let cached: string | null = null;

export function codeVersion(): string {
  if (cached !== null) return cached;
  cached = readGitShortSha() ?? "unknown";
  return cached;
}

function readGitShortSha(): string | null {
  try {
    let dir = process.cwd();
    for (let i = 0; i < 4; i++) {
      const gitPath = path.join(dir, ".git");
      if (fs.existsSync(gitPath)) {
        const head = fs.readFileSync(path.join(gitPath, "HEAD"), "utf8").trim();
        if (!head.startsWith("ref:")) return head.slice(0, 12);
        const refRel = head.slice(4).trim();
        const refFile = path.join(gitPath, refRel);
        if (fs.existsSync(refFile)) {
          return fs.readFileSync(refFile, "utf8").trim().slice(0, 12);
        }
        const packed = path.join(gitPath, "packed-refs");
        if (fs.existsSync(packed)) {
          const line = fs
            .readFileSync(packed, "utf8")
            .split("\n")
            .find((l) => l.endsWith(refRel));
          if (line) return line.split(" ")[0]!.slice(0, 12);
        }
        return null;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // stamping is best-effort — never let it break a telemetry write
  }
  return null;
}

/** Test seam. */
export function resetCodeVersionCache(): void {
  cached = null;
}
