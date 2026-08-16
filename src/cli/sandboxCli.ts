import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config/index.js";
import { startEmployerSandbox } from "../sandbox/server.js";

const OPERATOR_RESUME = path.resolve(
  "private/candidate/resumes/Shubham_Kale_Citadel_NeurIPS_Resume.pdf",
);

/**
 * `npm run sandbox` — start the local employer sandbox and stay up until
 * Ctrl+C. See src/sandbox/server.ts for what the pages exercise, and
 * docs/operator-guide.md §"Employer sandbox" for the drive-it recipes.
 */
export async function runSandboxCommand(args: string[]): Promise<void> {
  const portFlag = args.indexOf("--port");
  const port =
    portFlag >= 0 && args[portFlag + 1] ? Number(args[portFlag + 1]) : 4599;
  const handle = await startEmployerSandbox({ port });
  const configured = getConfig().defaultResumePath;
  const resume = fs.existsSync(OPERATOR_RESUME) ? OPERATOR_RESUME : configured;
  const resumeFlag = `--resume "${resume}"`;
  console.log("");
  console.log("Drive it with your real presets (flags come from `.env`):");
  console.log(
    `  npm run ats:fill -- --url ${handle.url}/gauntlet --execute --headed ${resumeFlag}`,
  );
  console.log(
    `  npm run ats:fill -- --url ${handle.url}/gauntlet --execute --submit --yes --headed ${resumeFlag}`,
  );
  console.log(
    `  npm run ats:fill -- --url ${handle.url}/portal --execute --headed ${resumeFlag}`,
  );
  console.log(
    "  (/portal needs NAVIGATION_ENABLED, GMAIL_VERIFICATION_ENABLED, and PORTAL_LOGIN_EMAIL/PASSWORD in `.env` — posting, then account wall, then the mailbox scan types the emailed code)",
  );
  console.log(
    `  npm run ats:fill -- --url ${handle.url}/navhard --execute --headed ${resumeFlag}`,
  );
  console.log(
    "  (/navhard is a posting: cookie banner + decoys + late popup → lead-capture form. --execute clicks Apply.)",
  );
  console.log(
    `  npm run ats:fill -- --url ${handle.url}/fillhard --execute --headed ${resumeFlag}`,
  );
  console.log(
    "  (/fillhard form lives in an iframe; --execute hops in and fills.)",
  );
  if (!fs.existsSync(resume)) {
    console.log(
      `  (DEFAULT_RESUME_PATH missing at ${resume} — set it or the resume field stays SKIP)`,
    );
  }
  console.log(
    "  npm run screeners:forget   — wipe learned Q/A pairs before a fresh gauntlet run",
  );
  console.log("");
  console.log(
    "This terminal echoes page hits, the LLM request/response, the fill plan, and what the fake employer receives.",
  );
  console.log("Same dumps land in artifacts/sandbox/. Restart this process after pulling sandbox/trace changes.");
  console.log("Ctrl+C stops the sandbox (accounts reset on restart).");
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      void handle.close().then(resolve);
    });
    process.on("SIGTERM", () => {
      void handle.close().then(resolve);
    });
  });
}
