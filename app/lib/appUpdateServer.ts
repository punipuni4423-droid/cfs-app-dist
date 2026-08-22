import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type AppUpdateState =
  | "current"
  | "available"
  | "build_required"
  | "blocked"
  | "not_configured"
  | "checking_failed";

export interface AppUpdateRunStatus {
  state?: string;
  startedAt?: string;
  finishedAt?: string;
  currentStep?: string;
  progress?: number;
  message?: string;
  logPath?: string;
  backupPath?: string;
}

export interface AppUpdateStatus {
  enabled: boolean;
  state: AppUpdateState;
  message: string;
  branch?: string;
  upstream?: string;
  localSha?: string;
  remoteSha?: string;
  buildSha?: string;
  buildBuiltAt?: string;
  buildDistDir?: string;
  buildInfoPath?: string;
  buildStale?: boolean;
  ahead: number;
  behind: number;
  dirty: boolean;
  checkedAt: string;
  appDir: string;
  gitPath?: string;
  lastRun?: AppUpdateRunStatus;
}

const GIT_TIMEOUT_MS = 20_000;
const GIT_FETCH_TIMEOUT_MS = Number.parseInt(process.env.CFS_GIT_FETCH_TIMEOUT_MS ?? "", 10) || GIT_TIMEOUT_MS;
const MAX_BUFFER = 1024 * 1024;

function resolveAppDir(): string {
  const configured = process.env.CFS_APP_DIR?.trim();
  if (configured) return path.resolve(configured);

  const startDirectory = process.cwd();
  let currentDirectory = startDirectory;
  while (true) {
    if (existsSync(path.join(currentDirectory, ".git")) && existsSync(path.join(currentDirectory, "package.json"))) {
      return currentDirectory;
    }
    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return startDirectory;
    }
    currentDirectory = parentDirectory;
  }
}

export const appDir = resolveAppDir();
export const selfUpdateDir = path.join(appDir, "artifacts", "self-update");
export const selfUpdateStatusFile = path.join(selfUpdateDir, "status.json");

interface AppBuildInfo {
  gitSha?: string;
  builtAt?: string;
  distDir?: string;
}

interface AppBuildInfoRecord {
  info: AppBuildInfo;
  filePath: string;
}

interface AppBuildStatusFields {
  buildSha?: string;
  buildBuiltAt?: string;
  buildDistDir?: string;
  buildInfoPath?: string;
  buildStale: boolean;
}

class GitUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitUnavailableError";
  }
}

function candidateGitPaths(): string[] {
  const candidates: string[] = [];
  const configured = process.env.CFS_GIT_EXE?.trim();
  if (configured) candidates.push(path.resolve(configured));

  const runtimeRoot = path.join(appDir, ".cfs-runtime");
  const bundledHomes = [path.join(runtimeRoot, "git")];
  try {
    for (const entry of readdirSync(runtimeRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && (/^PortableGit/i.test(entry.name) || /^git-/i.test(entry.name))) {
        bundledHomes.push(path.join(runtimeRoot, entry.name));
      }
    }
  } catch {
    // The runtime folder is optional. Fall back to PATH below.
  }

  for (const home of bundledHomes) {
    candidates.push(
      path.join(home, "cmd", "git.exe"),
      path.join(home, "bin", "git.exe"),
      path.join(home, "mingw64", "bin", "git.exe"),
      path.join(home, "mingw32", "bin", "git.exe"),
    );
  }

  return candidates;
}

function resolveGitExecutable(): string {
  for (const candidate of candidateGitPaths()) {
    if (existsSync(candidate)) return candidate;
  }
  return "git";
}

function isCommandNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}

async function runGit(args: string[], options: { timeoutMs?: number; allowFailure?: boolean } = {}): Promise<string> {
  const gitExecutable = resolveGitExecutable();
  try {
    const result = await execFileAsync(gitExecutable, args, {
      cwd: appDir,
      timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: MAX_BUFFER,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "echo",
        GCM_INTERACTIVE: "Never",
      },
    });
    return result.stdout.trim();
  } catch (error) {
    if (isCommandNotFound(error)) {
      throw new GitUnavailableError(
        "Git was not found. Use the latest CFS Git-managed ZIP with bundled PortableGit, or install Git for Windows and restart CFS.",
      );
    }
    if (options.allowFailure) return "";
    throw error;
  }
}

async function readLastRun(): Promise<AppUpdateRunStatus | undefined> {
  try {
    const raw = await readFile(selfUpdateStatusFile, "utf8");
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (parsed === null || typeof parsed !== "object") return undefined;
    return parsed as AppUpdateRunStatus;
  } catch {
    return undefined;
  }
}

// An update interrupted by a full disk leaves tracked files truncated to
// zero bytes and permanently "blocked". That signature is safe to heal by
// restoring the files from the current commit; real local edits (non-empty
// files) are never touched.
async function healZeroByteTrackedFiles(): Promise<boolean> {
  const porcelain = await runGit(["status", "--porcelain", "--untracked-files=no"], { allowFailure: true });
  const lines = porcelain.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  if (lines.length === 0) return false;
  for (const line of lines) {
    let relPath = line.slice(3).replace(/^"|"$/g, "");
    const renameSplit = relPath.split(" -> ");
    if (renameSplit.length > 1) relPath = renameSplit[renameSplit.length - 1].replace(/^"|"$/g, "");
    const fullPath = path.join(appDir, relPath);
    try {
      const info = await stat(fullPath);
      if (info.size > 0) return false;
    } catch {
      // Missing file (deleted mid-update) is part of the same signature.
    }
  }
  await runGit(["checkout", "--force", "--", "."], { allowFailure: true });
  return true;
}

async function readBuildInfo(): Promise<AppBuildInfoRecord | undefined> {
  const candidates = Array.from(
    new Set([
      path.join(appDir, ".cfs-build-info.json"),
      path.join(process.cwd(), ".cfs-build-info.json"),
      path.join(appDir, "runtime", ".cfs-build-info.json"),
    ]),
  );

  for (const candidate of candidates) {
    try {
      const raw = await readFile(candidate, "utf8");
      const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
      if (parsed === null || typeof parsed !== "object") continue;
      const info = parsed as AppBuildInfo;
      if (typeof info.gitSha !== "string" && typeof info.builtAt !== "string") continue;
      return { info, filePath: candidate };
    } catch {
      // Build metadata is optional for old packages and development checkouts.
    }
  }

  return undefined;
}

function buildStatusFields(buildInfo: AppBuildInfoRecord | undefined, localSha?: string): AppBuildStatusFields {
  const buildSha = buildInfo?.info.gitSha?.trim() || undefined;
  const buildBuiltAt = buildInfo?.info.builtAt?.trim() || undefined;
  const buildDistDir = buildInfo?.info.distDir?.trim() || undefined;
  return {
    buildSha,
    buildBuiltAt,
    buildDistDir,
    buildInfoPath: buildInfo?.filePath,
    buildStale: Boolean(buildSha && localSha && buildSha !== localSha),
  };
}

function shortSha(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}

const GIT_AUTH_FAILURE_MARKERS = [
  "authentication failed",
  "could not read username",
  "could not read password",
  "terminal prompts disabled",
  "invalid username or",
  "http 403",
  "403 forbidden",
  "repository not found",
];

function isGitAuthFailure(stderrText: string): boolean {
  const lowered = stderrText.toLowerCase();
  return GIT_AUTH_FAILURE_MARKERS.some((marker) => lowered.includes(marker));
}

function remoteCheckFailureMessage(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "killed" in error &&
    (error as { killed?: boolean }).killed
  ) {
    return "Git remote check timed out. CFS can still be used; check network or GitHub access before updating.";
  }
  const stderrText =
    error && typeof error === "object" && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr ?? "")
      : "";
  if (isGitAuthFailure(stderrText)) {
    return "Update repository sign-in failed (private repository or missing Git credentials on this PC). CFS can still be used; ask the distributor for read access, then use Retry Check.";
  }
  return "Git remote could not be checked. CFS can still be used; check network or GitHub access before updating.";
}

export async function getAppUpdateStatus(options: { fetchRemote?: boolean } = {}): Promise<AppUpdateStatus> {
  const checkedAt = new Date().toISOString();
  const lastRun = await readLastRun();
  const gitExecutable = resolveGitExecutable();
  const resolvedGitPath = gitExecutable === "git" ? undefined : gitExecutable;
  try {
    const repoRoot = await runGit(["rev-parse", "--show-toplevel"], { allowFailure: true });
    if (!repoRoot) {
      return {
        enabled: true,
        state: "not_configured",
        message: "Git repository was not found. Launch CFS from the latest extracted Git-managed folder.",
        ahead: 0,
        behind: 0,
        dirty: false,
        checkedAt,
        appDir,
        gitPath: resolvedGitPath,
        lastRun,
      };
    }

    const trackedPackage = await runGit(["ls-files", "--error-unmatch", "--", "package.json"], {
      allowFailure: true,
    });
    if (!trackedPackage) {
      return {
        enabled: true,
        state: "not_configured",
        message: "CFS app folder is not tracked by Git.",
        ahead: 0,
        behind: 0,
        dirty: false,
        checkedAt,
        appDir,
        gitPath: resolvedGitPath,
        lastRun,
      };
    }

    const branch = await runGit(["branch", "--show-current"], { allowFailure: true });
    const upstream = await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
      allowFailure: true,
    });
    if (!upstream) {
      return {
        enabled: true,
        state: "not_configured",
        message: branch
          ? `Branch ${branch} does not have an upstream remote.`
          : "Current Git branch does not have an upstream remote.",
        branch: branch || undefined,
        ahead: 0,
        behind: 0,
        dirty: false,
        checkedAt,
        appDir,
        gitPath: resolvedGitPath,
        lastRun,
      };
    }

    let dirty = (await runGit(["status", "--porcelain", "--untracked-files=no"], { allowFailure: true })).length > 0;
    if (dirty && (await healZeroByteTrackedFiles())) {
      dirty = (await runGit(["status", "--porcelain", "--untracked-files=no"], { allowFailure: true })).length > 0;
    }
    const localSha = await runGit(["rev-parse", "HEAD"]);
    const remoteSha = await runGit(["rev-parse", "@{u}"]);
    const buildInfo = await readBuildInfo();
    const buildFields = buildStatusFields(buildInfo, localSha);
    if (dirty) {
      return {
        enabled: true,
        state: "blocked",
        message: "Automatic update is blocked because local tracked files have changes.",
        branch: branch || undefined,
        upstream,
        localSha,
        remoteSha,
        ...buildFields,
        ahead: 0,
        behind: 0,
        dirty,
        checkedAt,
        appDir,
        gitPath: resolvedGitPath,
        lastRun,
      };
    }

    if (options.fetchRemote !== false) {
      try {
        await runGit(["fetch", "--prune", "--quiet"], { timeoutMs: GIT_FETCH_TIMEOUT_MS });
      } catch (error) {
        return {
          enabled: true,
          state: "checking_failed",
          message: remoteCheckFailureMessage(error),
          branch: branch || undefined,
          upstream,
          localSha,
          remoteSha,
          ...buildFields,
          ahead: 0,
          behind: 0,
          dirty,
          checkedAt,
          appDir,
          gitPath: resolvedGitPath,
          lastRun,
        };
      }
    }

    const refreshedRemoteSha = await runGit(["rev-parse", "@{u}"]);
    const counts = await runGit(["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
    const [aheadText, behindText] = counts.split(/\s+/);
    const ahead = Number.parseInt(aheadText ?? "0", 10) || 0;
    const behind = Number.parseInt(behindText ?? "0", 10) || 0;
    const diverged = ahead > 0 && behind > 0;
    const state: AppUpdateState = diverged
      ? "blocked"
      : behind > 0
        ? "available"
        : buildFields.buildStale
          ? "build_required"
          : "current";
    const message =
      state === "available"
        ? `Update available: ${shortSha(localSha)} -> ${shortSha(refreshedRemoteSha)}.`
        : state === "build_required"
          ? `Rebuild required: Git is ${shortSha(localSha)}, but the running build is ${shortSha(buildFields.buildSha ?? "")}.`
        : diverged
            ? "Automatic update is blocked because local and upstream Git histories have diverged."
            : ahead > 0
              ? "This installation has local commits ahead of the remote."
              : "Latest version installed. Safe to use.";

    return {
      enabled: true,
      state,
      message,
      branch: branch || undefined,
      upstream,
      localSha,
      remoteSha: refreshedRemoteSha,
      ...buildFields,
      ahead,
      behind,
      dirty,
      checkedAt,
      appDir,
      gitPath: resolvedGitPath,
      lastRun,
    };
  } catch (error) {
    if (error instanceof GitUnavailableError) {
      return {
        enabled: true,
        state: "not_configured",
        message: error.message,
        ahead: 0,
        behind: 0,
        dirty: false,
        checkedAt,
        appDir,
        lastRun,
      };
    }

    return {
      enabled: true,
      state: "checking_failed",
      message: error instanceof Error ? error.message : "Failed to check for updates.",
      ahead: 0,
      behind: 0,
      dirty: false,
      checkedAt,
      appDir,
      gitPath: resolvedGitPath,
      lastRun,
    };
  }
}
