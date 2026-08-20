param(
  [Parameter(Mandatory = $true)]
  [string]$ArchivePath,
  [switch]$AllowBundledRuntime
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$archive = (Resolve-Path -LiteralPath $ArchivePath).Path
$audit = Join-Path $PSScriptRoot 'audit-release-secrets.ps1'
$scratch = Join-Path ([System.IO.Path]::GetTempPath()) ("cfs-release-inspect-" + [guid]::NewGuid().ToString('N'))
try {
  Expand-Archive -LiteralPath $archive -DestinationPath $scratch -Force
  if ($AllowBundledRuntime) {
    & $audit -Path $scratch -AllowBundledRuntime
  } else {
    & $audit -Path $scratch
  }
  [PSCustomObject]@{ Archive = $archive; Result = 'pass' } | ConvertTo-Json
} finally {
  if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force }
}
