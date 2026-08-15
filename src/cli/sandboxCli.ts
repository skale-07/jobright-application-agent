import { startEmployerSandbox } from "../sandbox/server.js";

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
  console.log("");
  console.log("Drive it with your real presets (flags come from YOUR shell):");
  console.log(
    `  npm run ats:fill -- --url ${handle.url}/gauntlet --execute --headed`,
  );
  console.log(
    `  npm run ats:fill -- --url ${handle.url}/portal --execute --headed`,
  );
  console.log("");
  console.log(
    "Everything the fake employer receives is echoed here and written to artifacts/sandbox/.",
  );
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
