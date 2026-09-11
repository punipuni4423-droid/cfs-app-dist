param(
  [Parameter(Mandatory = $true)][string]$AppDir,
  [Parameter(Mandatory = $true)][ValidateSet('standalone', 'runtime')][string]$LegacyStore,
  [Parameter(Mandatory = $true)][switch]$LocalModeConfirmed,
  [int]$Port = 3014,
  [string]$HostName = '0.0.0.0',
  [switch]$RunOfficialUpdater
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'cfs-local-data-preservation.ps1')
$appRoot = Assert-CfsPlainPath -Path (Resolve-Path -LiteralPath $AppDir).Path
if (-not $LocalModeConfirmed) { throw 'Confirm this installation uses local project storage.' }
if ($env:CFS_SHARING_MODE -eq 'supabase') { throw 'Shared Supabase projects are not a local migration target.' }
foreach ($name in @('cfs-public-supabase.env', '.env', '.env.local', '.env.production', '.env.production.local')) {
  $envFile = Join-Path $appRoot $name
  if (Test-Path -LiteralPath $envFile) {
    if (@(Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^\s*CFS_SHARING_MODE\s*=\s*["'']?supabase\b' }).Count -gt 0) {
      throw 'Shared Supabase configuration detected. Do not migrate local remnants as shared projects.'
    }
  }
}
$updater = Assert-CfsChildPath -Root $appRoot -Path (Join-Path $appRoot 'scripts\update-cfs-app.ps1')
if ($RunOfficialUpdater -and -not (Test-Path -LiteralPath $updater -PathType Leaf)) { throw 'Official app updater was not found.' }
$relative = if ($LegacyStore -eq 'standalone') { '.next\standalone\data' } else { 'runtime\data' }
$legacy = Assert-CfsChildPath -Root $appRoot -Path (Join-Path $appRoot $relative)
$otherRelative = if ($LegacyStore -eq 'standalone') { 'runtime\data' } else { '.next\standalone\data' }
$other = Assert-CfsChildPath -Root $appRoot -Path (Join-Path $appRoot $otherRelative)
if (@(Get-CfsDataInventory -Directory $other).Count -gt 0) { throw 'Multiple legacy data stores exist; inventory and select the authoritative store before migration.' }
if (-not (Test-Path -LiteralPath $legacy -PathType Container)) { throw 'Selected legacy data directory does not exist.' }

Write-Output 'Stopping this local installation. Keep all launchers and editors closed until maintenance completes.'
Stop-CfsDataWriters -AppRoot $appRoot -Port $Port
try {
  $backup = Invoke-CfsLegacyDataCopy -AppRoot $appRoot -LegacyDirectory $legacy
  Assert-CfsWritersStopped -AppRoot $appRoot -Port $Port
  Write-Output "Verified original backups and canonical copy: $backup"
  if ($RunOfficialUpdater) {
    # Invoke the installed official worker directly while the old server stays
    # stopped. It loads its own version; no live source patch or UI-only claim.
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $updater -AppDir $appRoot -Port $Port -HostName $HostName
    if ($LASTEXITCODE -ne 0) { throw "Official updater failed (exit $LASTEXITCODE). Inspect artifacts\self-update before restarting." }
  } else {
    Write-Output 'Migration verified; server remains stopped. Invoke the official updater before allowing any old app restart.'
  }
} catch {
  Write-Error ("Maintenance stopped. Do not update or restart until the retained originals/backups are reviewed. " + $_.Exception.Message)
  exit 1
}
