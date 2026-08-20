param(
  [string]$AppRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$DistWorkingCopy = "C:\dev\AI\CFS\_cfs-app-dist",
  [string]$DistRemoteUrl = "https://github.com/punipuni4423-droid/cfs-app-dist.git",
  [switch]$NoPush
)

# Publishes the current cfs-app HEAD tree to the public distribution repository
# as one new commit (linear history, fast-forward for recipients). The private
# cfs-app history is never pushed; customer-named one-off scripts are excluded.

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# One-off data-repair scripts that reference customer projects. Never ship these
# in the public distribution repo. Keep this list in sync with the audit in
# docs/SELF_UPDATE.md (distribution section).
$excludedPaths = @(
  "scripts/fix-jet-sw1-refresh-bedroom.mjs",
  "scripts/import-jet-cfs-workbook.mjs",
  "scripts/import-legacy-cfs-workbook.mjs",
  "scripts/repair-hilton-renovation2-circuit-integrity.mjs",
  "scripts/update-hilton-260805-cfs.mjs",
  "scripts/update-jet-night-area-scenes.mjs",
  "scripts/update-jet-relax-refresh-area-scenes.mjs"
)

# Content patterns that must never appear in the distribution tree.
$forbiddenContentPattern = "hilton|conrad|ascott|capera|nohga|gofukubashi|vepvjvidkejgaqwcmpmi"

$sourceSha = (& git -C $AppRoot rev-parse HEAD).Trim()
if (-not $sourceSha) { throw "Could not resolve cfs-app HEAD." }
$dirty = (& git -C $AppRoot status --porcelain --untracked-files=no) -join ""
if ($dirty) { throw "cfs-app has uncommitted tracked changes. Commit first so the dist snapshot is traceable." }

if (-not (Test-Path -LiteralPath (Join-Path $DistWorkingCopy ".git"))) {
  throw "Dist working copy not found: $DistWorkingCopy (clone $DistRemoteUrl first)"
}

& git -C $DistWorkingCopy fetch origin | Out-Host
& git -C $DistWorkingCopy checkout master | Out-Host
& git -C $DistWorkingCopy reset --hard origin/master | Out-Host

# Replace the working tree content with the cfs-app HEAD tree (minus exclusions).
Get-ChildItem -LiteralPath $DistWorkingCopy -Force |
  Where-Object { $_.Name -ne ".git" } |
  Remove-Item -Recurse -Force

$archive = Join-Path ([System.IO.Path]::GetTempPath()) ("cfs-dist-" + [guid]::NewGuid().ToString("N") + ".tar")
& git -C $AppRoot archive --format=tar -o $archive HEAD
if ($LASTEXITCODE -ne 0) { throw "git archive failed." }
try {
  & tar -xf $archive -C $DistWorkingCopy
  if ($LASTEXITCODE -ne 0) { throw "tar extract failed." }
} finally {
  Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
}

foreach ($path in $excludedPaths) {
  $full = Join-Path $DistWorkingCopy ($path -replace "/", "\")
  if (Test-Path -LiteralPath $full) { Remove-Item -LiteralPath $full -Force }
}

# Audit: fail the sync if any forbidden content slipped into the dist tree.
$hits = & git -C $DistWorkingCopy grep -Il -iE $forbiddenContentPattern -- . 2>$null
if ($LASTEXITCODE -eq 0 -and $hits) {
  throw "Forbidden content found in dist tree:`n$($hits -join "`n")"
}

& git -C $DistWorkingCopy add -A
$staged = (& git -C $DistWorkingCopy status --porcelain) -join ""
if (-not $staged) {
  Write-Host "Dist repo is already up to date with cfs-app $($sourceSha.Substring(0,12))."
  exit 0
}

& git -C $DistWorkingCopy -c user.name="punipuni4423-droid" -c user.email="punipuni4423-droid@users.noreply.github.com" commit -m "CFS release (source cfs-app $($sourceSha.Substring(0,12)))" | Out-Host
if ($LASTEXITCODE -ne 0) { throw "Dist commit failed." }

if ($NoPush) {
  Write-Host "Committed locally. Push skipped by -NoPush."
} else {
  & git -C $DistWorkingCopy push origin master | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "Dist push failed." }
}

[PSCustomObject]@{
  SourceSha = $sourceSha
  DistSha = (& git -C $DistWorkingCopy rev-parse HEAD).Trim()
  DistRemote = $DistRemoteUrl
  ExcludedFiles = $excludedPaths.Count
} | ConvertTo-Json
