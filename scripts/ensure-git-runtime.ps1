[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$AppRoot,
  [switch]$AppLocalOnly,
  [switch]$NoInstall
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-GitExeFromHome {
  param([Parameter(Mandatory = $true)][string]$HomePath)

  foreach ($relative in @("cmd\git.exe", "bin\git.exe", "mingw64\bin\git.exe", "mingw32\bin\git.exe")) {
    $candidate = Join-Path $HomePath $relative
    if (Test-Path -LiteralPath $candidate) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  return $null
}

function Get-ExistingGitExe {
  param(
    [Parameter(Mandatory = $true)][string]$RuntimeRoot,
    [bool]$IncludePath = $true
  )

  $homes = New-Object System.Collections.Generic.List[string]
  $homes.Add((Join-Path $RuntimeRoot "git"))

  if (Test-Path -LiteralPath $RuntimeRoot) {
    Get-ChildItem -LiteralPath $RuntimeRoot -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like "PortableGit*" -or $_.Name -like "git-*" } |
      ForEach-Object { $homes.Add($_.FullName) }
  }

  foreach ($gitHome in $homes) {
    $gitExe = Get-GitExeFromHome -HomePath $gitHome
    if ($gitExe) {
      return $gitExe
    }
  }

  if ($IncludePath) {
    $pathGit = Get-Command git.exe -ErrorAction SilentlyContinue
    if ($pathGit -and $pathGit.Source) {
      return $pathGit.Source
    }
  }

  return $null
}

function Get-PortableGitAssetPattern {
  if ([Environment]::Is64BitOperatingSystem) {
    return '^PortableGit-.*-64-bit\.7z\.exe$'
  }

  return '^PortableGit-.*-32-bit\.7z\.exe$'
}

function Assert-ChildPath {
  param(
    [Parameter(Mandatory = $true)][string]$ParentPath,
    [Parameter(Mandatory = $true)][string]$ChildPath
  )

  $parentFull = [System.IO.Path]::GetFullPath($ParentPath).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  $childFull = [System.IO.Path]::GetFullPath($ChildPath)
  if (-not $childFull.StartsWith($parentFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to operate outside CFS runtime folder: $childFull"
  }
}

$appPath = (Resolve-Path -LiteralPath $AppRoot).Path
$runtimeRoot = Join-Path $appPath ".cfs-runtime"
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null

$lockPath = Join-Path $runtimeRoot "git-install.lock"
$lockStream = $null
$deadline = (Get-Date).AddMinutes(15)

while ($null -eq $lockStream) {
  try {
    $lockStream = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  } catch [System.IO.IOException] {
    if ((Get-Date) -ge $deadline) {
      throw "Timed out while waiting for another CFS process to finish preparing Git."
    }
    Start-Sleep -Seconds 1
  }
}

try {
  $existingGit = Get-ExistingGitExe -RuntimeRoot $runtimeRoot -IncludePath:(-not [bool]$AppLocalOnly)
  if ($existingGit) {
    Write-Output $existingGit
    return
  }

  if ($NoInstall) {
    throw "Git was not found. Use a CFS package with bundled PortableGit, or install Git for Windows and restart CFS."
  }

  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $release = Invoke-RestMethod `
    -Uri "https://api.github.com/repos/git-for-windows/git/releases/latest" `
    -Headers @{ "User-Agent" = "CFS-App-PortableGit-Installer" }
  $pattern = Get-PortableGitAssetPattern
  $asset = @($release.assets | Where-Object { $_.name -match $pattern } | Select-Object -First 1)

  if ($asset.Count -ne 1 -or -not $asset[0].browser_download_url) {
    throw "No supported PortableGit release asset was found."
  }

  $archivePath = Join-Path $runtimeRoot ([string]$asset[0].name)
  $stagingPath = Join-Path $runtimeRoot ("git-staging-" + [Guid]::NewGuid().ToString("N"))
  $targetPath = Join-Path $runtimeRoot "git"

  Assert-ChildPath -ParentPath $runtimeRoot -ChildPath $archivePath
  Assert-ChildPath -ParentPath $runtimeRoot -ChildPath $stagingPath
  Assert-ChildPath -ParentPath $runtimeRoot -ChildPath $targetPath

  try {
    Invoke-WebRequest -UseBasicParsing -Uri ([string]$asset[0].browser_download_url) -OutFile $archivePath
    New-Item -ItemType Directory -Force -Path $stagingPath | Out-Null
    & $archivePath -y "-o$stagingPath" | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "PortableGit extraction failed with exit code $LASTEXITCODE."
    }

    $stagedGit = Get-GitExeFromHome -HomePath $stagingPath
    if (-not $stagedGit) {
      throw "The downloaded PortableGit archive did not contain git.exe."
    }

    if (Test-Path -LiteralPath $targetPath) {
      Remove-Item -LiteralPath $targetPath -Recurse -Force
    }
    Move-Item -LiteralPath $stagingPath -Destination $targetPath -Force
  } finally {
    Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stagingPath -Recurse -Force -ErrorAction SilentlyContinue
  }

  $gitExe = Get-GitExeFromHome -HomePath $targetPath
  if (-not $gitExe) {
    throw "The app-local Git runtime could not be verified after installation."
  }

  Write-Output $gitExe
} finally {
  if ($null -ne $lockStream) {
    $lockStream.Dispose()
  }
}
