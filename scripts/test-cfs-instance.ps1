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
  $api = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "$baseUrl/api/sharing/config"
  $page = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "$baseUrl/"
  $status = Invoke-RestMethod -UseBasicParsing -TimeoutSec 3 "$baseUrl/api/app-update/status?fetchRemote=0"

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
