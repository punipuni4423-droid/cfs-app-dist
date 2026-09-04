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
  # Timeouts are split per endpoint (BUGREPORT_20260824 BUG-4): the status API
  # runs up to 8 serial git commands through the bundled PortableGit and takes
  # a measured 5-8 seconds on a cold start, so a flat 3-second timeout marked a
  # healthy server as "did not become ready".
  $api = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 "$baseUrl/api/sharing/config"
  $page = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 "$baseUrl/"
  $status = Invoke-RestMethod -UseBasicParsing -TimeoutSec 30 "$baseUrl/api/app-update/status?fetchRemote=0"

  if ($api.StatusCode -ne 200 -or $page.StatusCode -ne 200 -or $page.Content -notmatch "<html") {
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
