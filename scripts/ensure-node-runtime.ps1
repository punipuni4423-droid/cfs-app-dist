[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$AppRoot
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-NodePlatform {
  if ($env:PROCESSOR_ARCHITECTURE -match "ARM64") {
    return "win-arm64"
  }

  if ([Environment]::Is64BitOperatingSystem) {
    return "win-x64"
  }

  return "win-x86"
}

function Get-ExistingRuntime([string]$Root) {
  $node = Get-ChildItem -Path $Root -Filter "node.exe" -File -Recurse -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.Directory.FullName "npm.cmd") } |
    Select-Object -First 1

  if ($null -ne $node) {
    return $node.Directory.FullName
  }

  return $null
}

$appPath = (Resolve-Path -LiteralPath $AppRoot).Path
$runtimeRoot = Join-Path $appPath ".cfs-runtime"
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null

$lockPath = Join-Path $runtimeRoot "install.lock"
$lockStream = $null
$deadline = (Get-Date).AddMinutes(10)

while ($null -eq $lockStream) {
  try {
    $lockStream = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  }
  catch [System.IO.IOException] {
    if ((Get-Date) -ge $deadline) {
      throw "Timed out while waiting for another CFS startup to finish preparing Node.js."
    }
    Start-Sleep -Seconds 1
  }
}

try {
  $existingRuntime = Get-ExistingRuntime $runtimeRoot
  if ($null -ne $existingRuntime) {
    Write-Output $existingRuntime
    return
  }

  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $platform = Get-NodePlatform
  $index = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json"
  $fileName = "$platform-zip"
  $release = @($index | Where-Object { $_.lts -and $_.files -contains $fileName } | Select-Object -First 1)

  if ($release.Count -ne 1) {
    throw "No supported Node.js LTS ZIP was found for $platform."
  }

  $version = [string]$release[0].version
  $archiveName = "node-$version-$platform.zip"
  $archivePath = Join-Path $runtimeRoot $archiveName
  $stagingPath = Join-Path $runtimeRoot "staging-$([Guid]::NewGuid().ToString('N'))"
  $targetPath = Join-Path $runtimeRoot "node-$version-$platform"

  try {
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$version/$archiveName" -OutFile $archivePath
    $checksums = (Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$version/SHASUMS256.txt").Content
    $checksumLine = @($checksums -split "`r?`n" | Where-Object { $_ -match [regex]::Escape($archiveName) } | Select-Object -First 1)
    $checksumParts = @()
    if ($checksumLine.Count -eq 1) {
      $checksumParts = @($checksumLine[0].Trim() -split ' +')
    }
    if ($checksumParts.Count -lt 2 -or $checksumParts[0] -notmatch '^[a-fA-F0-9]{64}$' -or $checksumParts[-1] -ne $archiveName) {
      throw "The official SHA-256 entry for $archiveName was not found."
    }

    $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
    if (-not [string]::Equals($actualHash, $checksumParts[0], [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "The downloaded Node.js archive failed its official SHA-256 verification."
    }

    Expand-Archive -LiteralPath $archivePath -DestinationPath $stagingPath -Force
    $expandedRoot = Get-ChildItem -LiteralPath $stagingPath -Directory | Select-Object -First 1
    if ($null -eq $expandedRoot -or -not (Test-Path (Join-Path $expandedRoot.FullName "node.exe"))) {
      throw "The downloaded Node.js archive did not contain node.exe."
    }

    Move-Item -LiteralPath $expandedRoot.FullName -Destination $targetPath -Force
  }
  finally {
    Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stagingPath -Recurse -Force -ErrorAction SilentlyContinue
  }

  $runtime = Get-ExistingRuntime $runtimeRoot
  if ($null -eq $runtime) {
    throw "The app-local Node.js runtime could not be verified after installation."
  }

  Write-Output $runtime
}
finally {
  if ($null -ne $lockStream) {
    $lockStream.Dispose()
  }
}
