import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const appRoot = process.cwd();
const distDir = (process.env.NEXT_DIST_DIR || ".next").trim() || ".next";

function runGit(args) {
  try {
    return execFileSync("git", args, {
      cwd: appRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "echo",
        GCM_INTERACTIVE: "Never",
      },
    }).trim();
  } catch {
    return "";
  }
}

function readPackageVersion() {
  try {
    const raw = readFileSync(path.join(appRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed.version === "string" ? parsed.version : "";
  } catch {
    return "";
  }
}

function resolveDistPath() {
  return path.isAbsolute(distDir) ? distDir : path.join(appRoot, distDir);
}

const info = {
  schemaVersion: 1,
  gitSha: runGit(["rev-parse", "HEAD"]),
  gitBranch: runGit(["branch", "--show-current"]),
  gitUpstream: runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
  builtAt: new Date().toISOString(),
  distDir,
  packageVersion: readPackageVersion(),
};

const json = `${JSON.stringify(info, null, 2)}\n`;
const rootInfoPath = path.join(appRoot, ".cfs-build-info.json");
writeFileSync(rootInfoPath, json, "utf8");

const distInfoPath = path.join(resolveDistPath(), "cfs-build-info.json");
mkdirSync(path.dirname(distInfoPath), { recursive: true });
writeFileSync(distInfoPath, json, "utf8");

if (!info.gitSha) {
  console.warn("CFS build info written without a Git SHA. Update freshness checks will stay disabled for this build.");
} else {
  console.log(`CFS build info written for ${info.gitSha.slice(0, 12)}.`);
}
