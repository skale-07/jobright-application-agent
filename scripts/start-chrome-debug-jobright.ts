#!/usr/bin/env node
/**
 * Starts Google Chrome with remote debugging for JobRight Google OAuth.
 * You sign in manually; then run: npm run login:jobright -- --cdp http://127.0.0.1:9222
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import {
  cdpUserDataDir,
  chromeCdpLaunchArgs,
  defaultCdpUrl,
  findChromeExecutable,
} from "../src/auth/loginFlow.js";
import { getServiceAuthConfig } from "../src/auth/serviceRegistry.js";

const service = "jobright" as const;
const cfg = getServiceAuthConfig(service);
const chrome = findChromeExecutable();
const userDataDir = cdpUserDataDir(service);
const cdpUrl = defaultCdpUrl();
const port = new URL(cdpUrl).port || "9222";

if (!chrome) {
  console.error(
    "Google Chrome not found. Install Chrome or set CHROME_PATH to chrome.exe",
  );
  process.exit(1);
}

fs.mkdirSync(userDataDir, { recursive: true });

console.log("Starting Chrome with remote debugging...");
console.log(`Executable: ${chrome}`);
console.log(`User data dir: ${userDataDir}`);
console.log(`CDP: ${cdpUrl}`);
console.log(`Opening: ${cfg.loginUrl}`);
console.log("");
console.log("1. Sign into JobRight with Google in THIS Chrome window.");
console.log("2. When the JobRight app is loaded (logged in), run:");
console.log(`   npm run login:jobright -- --cdp ${cdpUrl}`);
console.log("");

const child = spawn(
  chrome,
  chromeCdpLaunchArgs({
    port,
    userDataDir,
    startUrl: cfg.loginUrl,
  }),
  {
    detached: true,
    stdio: "ignore",
  },
);
child.unref();
