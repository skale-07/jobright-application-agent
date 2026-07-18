import path from "node:path";

export const JOBRIGHT_WORKFLOWS = [
  "job-feed",
  "resume-generator",
  "cover-letter",
  "apply-autofill",
  "school-contacts",
  "beyond-network",
  "email-reveal",
] as const;

export type JobRightWorkflow = (typeof JOBRIGHT_WORKFLOWS)[number];

export const WORKFLOW_GUIDANCE: Record<JobRightWorkflow, string> = {
  "job-feed":
    "Confirm you are on Recommended Jobs (https://jobright.ai/jobs/recommend) with filtered internship cards visible (Apply with Autofill buttons).",
  "resume-generator":
    "Open a job and navigate to JobRight resume tailoring / keyword add-all UI.",
  "cover-letter":
    "Open the cover-letter generation or requirement UI for a job.",
  "apply-autofill":
    "Show the Apply / Apply with Autofill controls (do not need to finish apply).",
  "school-contacts":
    "Open networking contacts and select Find from your school.",
  "beyond-network":
    "Open Beyond your network contacts list.",
  "email-reveal":
    "Open Connect via email / Connect now so an email reveal UI is visible.",
};

export function isJobRightWorkflow(value: string): value is JobRightWorkflow {
  return (JOBRIGHT_WORKFLOWS as readonly string[]).includes(value);
}

export function parseWorkflow(value: string): JobRightWorkflow {
  if (!isJobRightWorkflow(value)) {
    throw new Error(
      `Unknown workflow "${value}". Expected one of: ${JOBRIGHT_WORKFLOWS.join(", ")}`,
    );
  }
  return value;
}

export function liveCapturesRoot(
  artifactsRoot = path.join(process.cwd(), "fixtures", "live-captures"),
): string {
  return artifactsRoot;
}

export function captureRunDir(
  workflow: JobRightWorkflow,
  runId: string,
  root = liveCapturesRoot(),
): string {
  return path.join(root, workflow, runId);
}

/** Committed sanitized fixtures derived from captures (optional later). */
export function derivedFixtureDir(
  workflow: JobRightWorkflow,
  fixturesRoot = path.join(process.cwd(), "tests", "fixtures", "jobright"),
): string {
  return path.join(fixturesRoot, workflow);
}

export function makeCaptureRunId(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

export type CaptureFileNames = {
  meta: "meta.json";
  screenshot: "screenshot.png";
  url: "url.txt";
  dom: "dom.sanitized.html";
  a11y: "a11y.sanitized.yml";
  labels: "labels.json";
  iframes: "iframes.json";
  network: "network.sanitized.json";
  pages: "pages.json";
  downloads: "downloads.json";
  routeLog: "route-log.json";
};

export const CAPTURE_FILES: CaptureFileNames = {
  meta: "meta.json",
  screenshot: "screenshot.png",
  url: "url.txt",
  dom: "dom.sanitized.html",
  a11y: "a11y.sanitized.yml",
  labels: "labels.json",
  iframes: "iframes.json",
  network: "network.sanitized.json",
  pages: "pages.json",
  downloads: "downloads.json",
  routeLog: "route-log.json",
};

export function defaultJobRightStartUrl(): string {
  return (
    process.env.JOBRIGHT_FEED_URL?.trim() ||
    "https://jobright.ai/jobs/recommend"
  );
}
