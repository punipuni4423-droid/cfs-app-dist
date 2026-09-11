import { requireApiAccess } from "../../../lib/apiAuth";
import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { appDir, getAppUpdateStatus, selfUpdateStatusFile } from "../../../lib/appUpdateServer";
import { isAllowedWriteRequest } from "../../../lib/requestGuard";
import { buildUpdateLaunchCommand, windowsPowerShellExecutable } from "../../../lib/appUpdateLaunch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function writeQueuedStatus(message: string): Promise<string> {
  const now = new Date().toISOString();
  await mkdir(path.dirname(selfUpdateStatusFile), { recursive: true });
  await writeFile(
    selfUpdateStatusFile,
    `${JSON.stringify(
      {
        state: "running",
        currentStep: "queued",
        progress: 1,
        message,
        updatedAt: now,
        startedAt: now,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return now;
}

async function writeLaunchFailure(message: string, startedAt: string): Promise<void> {
  const now = new Date().toISOString();
  await mkdir(path.dirname(selfUpdateStatusFile), { recursive: true });
  await writeFile(
    selfUpdateStatusFile,
    `${JSON.stringify(
      {
        state: "failed",
        currentStep: "launch",
        progress: 100,
        message,
        startedAt,
        updatedAt: now,
        finishedAt: now,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  const denied = await requireApiAccess(request, true);
  if (denied) return denied;
  if (!isAllowedWriteRequest(request)) {
    return NextResponse.json({ error: "update request origin is not allowed" }, { status: 403 });
  }

  const status = await getAppUpdateStatus();
  if (status.lastRun?.state === "running") {
    return NextResponse.json(
      { error: "an update is already running", status },
      { status: 409 },
    );
  }
  if (status.state !== "available" && status.state !== "build_required") {
    return NextResponse.json(
      { error: "update or rebuild is not available", status },
      { status: status.state === "blocked" ? 409 : 400 },
    );
  }

  const scriptPath = path.join(appDir, "scripts", "update-cfs-app.ps1");
  try {
    await access(scriptPath);
  } catch {
    return NextResponse.json({ error: "update script was not found" }, { status: 500 });
  }

  const requestUrl = new URL(request.url);
  const port = requestUrl.port || process.env.PORT || "3014";
  const startedAt = await writeQueuedStatus("Starting update process.");

  const startCommand = buildUpdateLaunchCommand({
    appDir,
    scriptPath,
    statusFile: selfUpdateStatusFile,
    port,
    hostName: process.env.CFS_LOCALHOST_ONLY === "1" ? "127.0.0.1" : "0.0.0.0",
    startedAt,
  });

  const child = spawn(
    windowsPowerShellExecutable(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      startCommand,
    ],
    {
      cwd: appDir,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.once("error", (error) => {
    void writeLaunchFailure(error instanceof Error ? error.message : "Failed to launch update process.", startedAt);
  });
  child.once("exit", (code) => {
    if (code && code !== 0) {
      void writeLaunchFailure(`Update launcher exited with code ${code}.`, startedAt);
    }
  });
  child.unref();

  return NextResponse.json({
    ok: true,
    state: "started",
    message: "Update started. The app will rebuild and restart automatically.",
    statusFile: selfUpdateStatusFile,
  });
}
