import { readFile } from "node:fs/promises";
import path from "node:path";
import { appDir } from "./appUpdateServer";
import { isAppBuildVersion, type AppBuildVersion } from "./appBuildVersion";

// Only the metadata next to the app folder is authoritative (B-026: copies
// under .next/standalone are stale leftovers and must not be consulted). The
// file is read per request, matching the Update status API, so the badge and
// the update tooltip never disagree about the running build.
export const RUNNING_BUILD_INFO_FILE = path.join(appDir, ".cfs-build-info.json");

export async function readRunningBuildInfo(): Promise<AppBuildVersion | null> {
  try {
    const raw = await readFile(RUNNING_BUILD_INFO_FILE, "utf8");
    const parsed: unknown = JSON.parse(raw.replace(/^﻿/, ""));
    if (!isAppBuildVersion(parsed)) return null;
    return {
      gitSha: parsed.gitSha.trim(),
      builtAt: parsed.builtAt?.trim() || undefined,
      packageVersion: parsed.packageVersion?.trim() || undefined,
    };
  } catch {
    // Missing or unreadable metadata (old packages, failed builds) is shown as
    // "Version unknown" rather than guessed from Git.
    return null;
  }
}
