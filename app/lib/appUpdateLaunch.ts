import path from "node:path";

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
