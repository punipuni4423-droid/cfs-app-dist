import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { appDir, getAppUpdateStatus, selfUpdateStatusFile } from "../../../lib/appUpdateServer";
import { isAllowedWriteRequest } from "../../../lib/requestGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function psSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function writeQueuedStatus(message: string): Promise<void> {
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
}

async function writeLaunchFailure(message: string): Promise<void> {
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
  await writeQueuedStatus("Starting update process.");

  const updateArgs = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-AppDir",
    appDir,
    "-Port",
    port,
    "-HostName",
    "0.0.0.0",
  ];
  const startCommand = [
    "$ErrorActionPreference = 'Stop';",
    `Start-Process -FilePath 'powershell.exe' -ArgumentList @(${updateArgs
      .map(psSingleQuoted)
      .join(", ")}) -WorkingDirectory ${psSingleQuoted(appDir)} -WindowStyle Hidden;`,
  ].join(" ");

  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
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
    void writeLaunchFailure(error instanceof Error ? error.message : "Failed to launch update process.");
  });
  child.once("exit", (code) => {
    if (code && code !== 0) {
      void writeLaunchFailure(`Update launcher exited with code ${code}.`);
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
