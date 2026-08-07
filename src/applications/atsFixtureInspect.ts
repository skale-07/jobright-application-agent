import fs from "node:fs";
import path from "node:path";
import { inspectApplicationHtml } from "./applicationInspector.js";
import { getConfig } from "../config/index.js";
import { writeJsonAtomic } from "../storage/atomicJson.js";

export const ATS_FIXTURE_NAMES = [
  "greenhouse",
  "essay",
  "demographics",
  "captcha",
  "login-required",
  "workday",
  "lever",
  "ashby",
] as const;

export type AtsFixtureName = (typeof ATS_FIXTURE_NAMES)[number];

export function atsFixtureDir(name: AtsFixtureName): string {
  return path.join(process.cwd(), "tests", "fixtures", "ats", name);
}

export function loadAtsFixture(name: AtsFixtureName): {
  url: string;
  title: string;
  html: string;
} {
  const dir = atsFixtureDir(name);
  const metaPath = path.join(dir, "meta.json");
  const htmlPath = path.join(dir, "dom.sanitized.html");
  if (!fs.existsSync(htmlPath)) {
    throw new Error(`Missing ATS fixture HTML: ${htmlPath}`);
  }
  const meta = fs.existsSync(metaPath)
    ? (JSON.parse(fs.readFileSync(metaPath, "utf8")) as {
        url?: string;
        title?: string;
      })
    : {};
  return {
    url: meta.url ?? `https://fixture.local/${name}`,
    title: meta.title ?? name,
    html: fs.readFileSync(htmlPath, "utf8"),
  };
}

export async function runAtsFixtureInspection(
  name: AtsFixtureName,
): Promise<{ reportPath: string; report: Awaited<ReturnType<typeof inspectApplicationHtml>> }> {
  const fixture = loadAtsFixture(name);
  const report = await inspectApplicationHtml(fixture);
  const cfg = getConfig();
  const outDir = path.join(cfg.artifactsDir, "ats-inspect", name);
  fs.mkdirSync(outDir, { recursive: true });
  const reportPath = path.join(outDir, "inspect-report.json");
  writeJsonAtomic(reportPath, {
    fixture: name,
    inspected_at: new Date().toISOString(),
    ...report,
  });
  return { reportPath, report };
}
