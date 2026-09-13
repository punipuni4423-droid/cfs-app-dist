import path from "node:path";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";

export type BootstrapStartResult = { state: "started" | "busy" | "failed" | "unknown"; message: string };

async function assertPlainDirectory(directory: string): Promise<void> {
  let cursor = path.resolve(directory);
  while (true) {
    const info = await fs.lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Update acknowledgement path is not a plain directory.");
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

export async function reserveBootstrapAcknowledgement(appRoot: string, attemptId: string): Promise<string> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attemptId)) throw new Error("Invalid update attempt.");
  let directory = path.resolve(appRoot);
  await assertPlainDirectory(directory);
  for (const part of ["artifacts", "self-update", "launch-acks"]) {
    directory = path.join(directory, part);
    try { await fs.mkdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await assertPlainDirectory(directory);
  }
  directory = path.join(directory, attemptId);
  await fs.mkdir(directory); // An existing attempt is never reused or overwritten.
  await assertPlainDirectory(directory);
  return path.join(directory, "ack.jsonl");
}

export function buildBootstrapBrokerInvocation(args: string[], appRoot: string, ackPath: string): string[] {
  // The API supplies only buildBootstrapInvocation's fixed argument shape.
  if (args.length !== 6 || args.slice(0, 5).join("|") !== "-NoProfile|-NonInteractive|-ExecutionPolicy|Bypass|-EncodedCommand") throw new Error("Invalid bootstrap invocation.");
  const command = Buffer.from(args[args.length - 1], "base64").toString("utf16le");
  const inner = [
    "$ErrorActionPreference='Stop'; $script:cfsAckPublished=$false;",
    "function Publish-CfsLaunchAck([string]$line) { if($script:cfsAckPublished){return};",
    `$cursor=${psString(path.dirname(ackPath))}; while($cursor){$item=Get-Item -LiteralPath $cursor -Force; if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Unsafe update acknowledgement path.'}; $cursor=[IO.Path]::GetDirectoryName($cursor)};`,
    `$stream=[IO.File]::Open(${psString(ackPath + ".tmp")},[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);`,
    "$writer=New-Object IO.StreamWriter($stream,(New-Object Text.UTF8Encoding($false))); try{$writer.WriteLine($line)}finally{$writer.Dispose()};",
    `[IO.File]::Move(${psString(ackPath + ".tmp")},${psString(ackPath)}); $script:cfsAckPublished=$true; };`,
    `try { & { ${command} } | ForEach-Object { $line=[string]$_; if($line.StartsWith('CFS_UPDATE_ACK:')){Publish-CfsLaunchAck $line} } }`,
    `catch { Publish-CfsLaunchAck 'CFS_UPDATE_ACK:{"state":"failed","message":"The update entry could not start. Use UPDATE_CFS_APP.cmd for diagnostics."}'; exit 1 }`,
  ].join(" ");
  const broker = `$ErrorActionPreference='Stop'; Start-Process -FilePath ${psString(windowsPowerShellExecutable())} -ArgumentList '-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(inner, "utf16le").toString("base64")}' -WorkingDirectory ${psString(appRoot)} -WindowStyle Hidden;`;
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(broker, "utf16le").toString("base64")];
}

export async function startBootstrap(args: string[], appRoot: string, attemptId: string): Promise<BootstrapStartResult> {
  const ackPath = await reserveBootstrapAcknowledgement(appRoot, attemptId);
  const child = spawn(windowsPowerShellExecutable(), buildBootstrapBrokerInvocation(args, appRoot, ackPath), { cwd: appRoot, stdio: "ignore", windowsHide: true });
  let spawnFailed = false;
  child.once("error", () => { spawnFailed = true; });
  // The broker normally exits before the worker acknowledges. Its exit is not
  // the worker's result, and parent shutdown must not dispose of the worker.
  child.unref();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (spawnFailed) return { state: "failed", message: "The update process could not be created. Use UPDATE_CFS_APP.cmd for diagnostics." };
    try {
      const info = await fs.lstat(ackPath);
      if (!info.isSymbolicLink() && info.isFile() && info.size <= 16384) {
        const match = (await fs.readFile(ackPath, "utf8")).match(/CFS_UPDATE_ACK:([^\r\n]+)[\r\n]/);
        if (match) {
          const value: unknown = JSON.parse(match[1]);
          if (value && typeof value === "object") {
            const ack = value as { state?: string; message?: string };
            if (["started", "busy", "failed"].includes(ack.state ?? "") && typeof ack.message === "string") return { state: ack.state as BootstrapStartResult["state"], message: ack.message };
          }
        }
      }
    } catch { /* Missing/partial/unavailable acknowledgement is not failure. */ }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  // Keep this attempt's files for diagnostics. Never kill, retry, or clean up a
  // possibly running worker after an unknown acknowledgement or parent exit.
  return { state: "unknown", message: "Update start is still being checked." };
}

export function buildBootstrapInvocation(options: { appDir: string; port: string; hostName: string; expectedHead: string; startedAt: string; attemptId: string; repairBuild: boolean }): string[] {
  const cached = path.join(options.appDir, '.cfs-updater', 'bootstrap-v1.ps1');
  const bootstrap = existsSync(cached) ? cached : path.join(options.appDir, 'scripts', 'cfs-update-bootstrap.ps1');
  const command = [
    "$ErrorActionPreference='Stop';",
    `$cursor=${psString(bootstrap)}; while($cursor){ if(Test-Path -LiteralPath $cursor){if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Update path is a reparse point.'}}; $cursor=[IO.Path]::GetDirectoryName($cursor) };`,
    `& ${psString(bootstrap)} -AppDir ${psString(options.appDir)} -Port ${psString(options.port)} -HostName ${psString(options.hostName)} -ExpectedHead ${psString(options.expectedHead)} -StartedAt ${psString(options.startedAt)} -AttemptId ${psString(options.attemptId)} -ApiHandshake${options.repairBuild ? ' -RepairBuild' : ''}; exit $LASTEXITCODE;`,
  ].join(' ');
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')];
}

function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// Start-Process joins ArgumentList with spaces; quoting each PowerShell array
// element does not preserve Windows argv boundaries. Carry paths in encoded
// PowerShell source instead of passing them through another argv conversion.
export function buildUpdateLaunchCommand(options: {
  appDir: string;
  scriptPath: string;
  statusFile: string;
  port: string;
  hostName: string;
  startedAt: string;
}): string {
  const worker = [
    "$ErrorActionPreference = 'Stop';",
    "try {",
    `& ${psString(options.scriptPath)} -AppDir ${psString(options.appDir)} -Port ${psString(options.port)} -HostName ${psString(options.hostName)};`,
    "} catch {",
    "$now = [DateTime]::UtcNow.ToString('o');",
    // No exception text: paths/configuration may contain sensitive arguments.
    `$failure = @{ state = 'failed'; currentStep = 'launch'; progress = 100; message = 'Update worker could not start. Check the extracted app folder and restart CFS.'; startedAt = ${psString(options.startedAt)}; updatedAt = $now; finishedAt = $now };`,
    `$failure | ConvertTo-Json | Set-Content -LiteralPath ${psString(options.statusFile)} -Encoding UTF8;`,
    "exit 1;",
    "}",
  ].join(" ");
  const encoded = Buffer.from(worker, "utf16le").toString("base64");
  return [
    "$ErrorActionPreference = 'Stop';",
    `Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList '-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}' -WorkingDirectory ${psString(options.appDir)} -WindowStyle Hidden;`,
  ].join(" ");
}

export function windowsPowerShellExecutable(): string {
  return path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
