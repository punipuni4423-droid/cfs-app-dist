param(
  [Parameter(Mandatory = $true)]
  [string]$AppRoot,
  [Parameter(Mandatory = $true)]
  [int]$Port,
  [Parameter(Mandatory = $true)]
  [ValidateSet("Standalone", "Npm")]
  [string]$Mode,
  [string]$ServerPath,
  [Parameter(Mandatory = $true)]
  [string]$StdoutPath,
  [Parameter(Mandatory = $true)]
  [string]$StderrPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = (Resolve-Path -LiteralPath $AppRoot).Path
if (-not (Test-Path -LiteralPath (Split-Path -Parent $StdoutPath))) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $StdoutPath) | Out-Null
}
if (-not (Test-Path -LiteralPath (Split-Path -Parent $StderrPath))) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $StderrPath) | Out-Null
}

$previousAppDir = $env:CFS_APP_DIR
$previousPort = $env:PORT
$previousHostname = $env:HOSTNAME
try {
  $env:CFS_APP_DIR = $root
  $env:PORT = [string]$Port
  $env:HOSTNAME = "0.0.0.0"

  if ($Mode -eq "Standalone") {
    if (-not $ServerPath) {
      throw "ServerPath is required for Standalone mode."
    }
    $server = (Resolve-Path -LiteralPath $ServerPath).Path
    $process = Start-Process -FilePath "node.exe" `
      -ArgumentList @($server) `
      -WorkingDirectory $root `
      -WindowStyle Hidden `
      -RedirectStandardOutput $StdoutPath `
      -RedirectStandardError $StderrPath `
      -PassThru
  } else {
    $process = Start-Process -FilePath "npm.cmd" `
      -ArgumentList @("run", "start", "--", "-p", [string]$Port, "-H", "0.0.0.0") `
      -WorkingDirectory $root `
      -WindowStyle Hidden `
      -RedirectStandardOutput $StdoutPath `
      -RedirectStandardError $StderrPath `
      -PassThru
  }

  "Started CFS server process pid $($process.Id) on port $Port."
} finally {
  if ($null -eq $previousAppDir) { Remove-Item Env:CFS_APP_DIR -ErrorAction SilentlyContinue } else { $env:CFS_APP_DIR = $previousAppDir }
  if ($null -eq $previousPort) { Remove-Item Env:PORT -ErrorAction SilentlyContinue } else { $env:PORT = $previousPort }
  if ($null -eq $previousHostname) { Remove-Item Env:HOSTNAME -ErrorAction SilentlyContinue } else { $env:HOSTNAME = $previousHostname }
}
