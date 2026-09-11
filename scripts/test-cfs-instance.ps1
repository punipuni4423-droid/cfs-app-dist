[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [int]$Port,
  [Parameter(Mandatory = $true)]
  [string]$AppRoot
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Normalize-PathForCompare {
  param([Parameter(Mandatory = $true)][string]$PathValue)

  return [System.IO.Path]::GetFullPath($PathValue).TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
  )
}

try {
  $expectedRoot = Normalize-PathForCompare -PathValue (Resolve-Path -LiteralPath $AppRoot).Path
  $baseUrl = "http://localhost:$Port"
  $previousAuthAppDir = $env:CFS_APP_DIR
  try {
    $env:CFS_APP_DIR = $expectedRoot
    $accessToken = & node.exe (Join-Path $expectedRoot 'scripts\cfs-access.mjs') session
    if ($LASTEXITCODE -ne 0 -or -not $accessToken) { exit 1 }
  } finally {
    if ($null -eq $previousAuthAppDir) { Remove-Item Env:CFS_APP_DIR -ErrorAction SilentlyContinue } else { $env:CFS_APP_DIR = $previousAuthAppDir }
  }
  $accessHeaders = @{ 'x-cfs-access-token' = $accessToken }
  # Timeouts are split per endpoint (BUGREPORT_20260824 BUG-4): the status API
  # runs up to 8 serial git commands through the bundled PortableGit and takes
  # a measured 5-8 seconds on a cold start, so a flat 3-second timeout marked a
  # healthy server as "did not become ready".
  $api = Invoke-WebRequest -UseBasicParsing -Headers $accessHeaders -TimeoutSec 5 "$baseUrl/api/sharing/config"
  $page = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 "$baseUrl/"
  $statusResponse = Invoke-WebRequest -UseBasicParsing -Headers $accessHeaders -TimeoutSec 30 "$baseUrl/api/app-update/status?fetchRemote=0"
  # Windows PowerShell 5 decodes JSON without a charset as Latin-1. Read the
  # original bytes as UTF-8 so Japanese installation paths compare correctly.
  $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
  $statusText = $utf8.GetString($statusResponse.RawContentStream.ToArray()).TrimStart([char]0xFEFF)
  $status = $statusText | ConvertFrom-Json

  if ($api.StatusCode -ne 200 -or $page.StatusCode -ne 200 -or $statusResponse.StatusCode -ne 200 -or $page.Content -notmatch "<html") {
    exit 1
  }

  if (-not $status.appDir) {
    exit 1
  }

  $actualRoot = Normalize-PathForCompare -PathValue ([string]$status.appDir)
  if ([string]::Equals($actualRoot, $expectedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    exit 0
  }

  exit 1
} catch {
  exit 1
}
