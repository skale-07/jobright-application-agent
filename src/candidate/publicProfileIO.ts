import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config/index.js";
import { parsePublicProfile, type PublicProfile } from "./publicProfile.js";

export function publicProfilePaths(): {
  profilePath: string;
  examplePath: string;
} {
  const cfg = getConfig();
  return {
    profilePath: path.join(cfg.privateDir, "candidate", "public-profile.json"),
    examplePath: path.join(
      cfg.privateDir,
      "candidate",
      "public-profile.example.json",
    ),
  };
}

export function loadPublicProfile(filePath?: string): PublicProfile {
  const { profilePath, examplePath } = publicProfilePaths();
  const target = filePath
    ? path.resolve(filePath)
    : fs.existsSync(profilePath)
      ? profilePath
      : examplePath;
  if (!fs.existsSync(target)) {
    throw new Error(
      `Public profile not found. Copy public-profile.example.json to public-profile.json (${target})`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(target, "utf8")) as unknown;
  return parsePublicProfile(raw);
}
