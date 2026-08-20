param(
  [string]$OutputDirectory = (Join-Path (Get-Location) "artifacts\share-packages"),
  [string]$PackageName = "CFS-GitManaged",
  [string]$RemoteUrl,
  [string]$RuntimeSourceDirectory,
  [switch]$IncludeSharedDatabaseConfig,
  [switch]$SkipRuntimeBuild,
  [switch]$ExcludeBundledNode,
  [switch]$ExcludeBundledGit
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$appRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$packageRoot = Join-Path $outputRoot "$PackageName-$stamp"
$archivePath = "$packageRoot.zip"
$runtimePackageName = "$PackageName-RuntimeSource"

function Assert-ChildPath {
  param(
    [Parameter(Mandatory = $true)][string]$ParentPath,
    [Parameter(Mandatory = $true)][string]$ChildPath
  )

  $parentFull = [System.IO.Path]::GetFullPath($ParentPath).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  $childFull = [System.IO.Path]::GetFullPath($ChildPath)
  if (-not $childFull.StartsWith($parentFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to operate outside target folder: $childFull"
  }
}

function Remove-PathIfExists {
  param([Parameter(Mandatory = $true)][string]$Path)

  Assert-ChildPath -ParentPath $outputRoot -ChildPath $Path
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
}

function Get-LastJsonObjectFromText {
  param([Parameter(Mandatory = $true)][string]$Text)

  $end = $Text.LastIndexOf("}")
  if ($end -lt 0) {
    throw "Could not find JSON output from runtime package builder."
  }

  $depth = 0
  for ($index = $end; $index -ge 0; $index--) {
    $char = $Text[$index]
    if ($char -eq "}") {
      $depth++
    } elseif ($char -eq "{") {
      $depth--
      if ($depth -eq 0) {
        return $Text.Substring($index, $end - $index + 1)
      }
    }
  }

  throw "Could not isolate JSON output from runtime package builder."
}

function New-ZipArchiveIncludingHidden {
  param(
    [Parameter(Mandatory = $true)][string]$SourceDirectory,
    [Parameter(Mandatory = $true)][string]$ArchivePath
  )

  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem

  $sourceFull = [System.IO.Path]::GetFullPath($SourceDirectory).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
  if (Test-Path -LiteralPath $ArchivePath) {
    Remove-Item -LiteralPath $ArchivePath -Force
  }

  $archive = [System.IO.Compression.ZipFile]::Open($ArchivePath, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    $files = Get-ChildItem -LiteralPath $sourceFull -Recurse -Force -File
    foreach ($file in $files) {
      $relativePath = $file.FullName.Substring($sourceFull.Length).TrimStart([char[]]@("\", "/")) -replace "\\", "/"
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $archive,
        $file.FullName,
        $relativePath,
        [System.IO.Compression.CompressionLevel]::Fastest
      ) | Out-Null
    }
  } finally {
    $archive.Dispose()
  }
}

if (-not $RemoteUrl) {
  $RemoteUrl = (& git -C $appRoot remote get-url origin).Trim()
}
if (-not $RemoteUrl) {
  throw "RemoteUrl is required when the source repository has no origin remote."
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
Remove-PathIfExists -Path $packageRoot
if (Test-Path -LiteralPath $archivePath) {
  Remove-Item -LiteralPath $archivePath -Force
}

if (-not $RuntimeSourceDirectory) {
  $builderArgs = @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    (Join-Path $PSScriptRoot "build-cfs-share-package.ps1"),
    "-OutputDirectory",
    $outputRoot,
    "-PackageName",
    $runtimePackageName
  )
  if ($IncludeSharedDatabaseConfig) {
    $builderArgs += "-IncludeSharedDatabaseConfig"
  }
  if ($SkipRuntimeBuild) {
    $builderArgs += "-SkipBuild"
  }
  if (-not $ExcludeBundledGit) {
    $builderArgs += "-IncludeBundledGit"
  }
  $builderArgs += "-SkipArchive"
  if ($ExcludeBundledNode) {
    $builderArgs += "-ExcludeBundledNode"
  }

  $builderOutput = & powershell.exe @builderArgs 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    Write-Host $builderOutput
    throw "Runtime package build failed."
  }

  $runtimeJson = Get-LastJsonObjectFromText -Text $builderOutput | ConvertFrom-Json
  $RuntimeSourceDirectory = $runtimeJson.PackageDirectory
}

$runtimeSource = (Resolve-Path -LiteralPath $RuntimeSourceDirectory).Path
foreach ($required in @("runtime", "Manual", "RELEASE_PACKAGE_MANIFEST.json")) {
  if (-not (Test-Path -LiteralPath (Join-Path $runtimeSource $required))) {
    throw "Runtime source is missing required item: $required"
  }
}
if (-not $ExcludeBundledNode -and -not (Test-Path -LiteralPath (Join-Path $runtimeSource ".cfs-runtime"))) {
  throw "Runtime source is missing bundled Node runtime."
}
if (-not $ExcludeBundledGit -and -not (Test-Path -LiteralPath (Join-Path $runtimeSource ".cfs-runtime\git"))) {
  throw "Runtime source is missing bundled Git runtime."
}
if ($IncludeSharedDatabaseConfig -and -not (Test-Path -LiteralPath (Join-Path $runtimeSource "cfs-public-supabase.env"))) {
  throw "Runtime source is missing public shared database config."
}

& git clone --local --no-hardlinks $appRoot $packageRoot | Out-Host
if ($LASTEXITCODE -ne 0) {
  throw "Git clone failed."
}

& git -C $packageRoot remote set-url origin $RemoteUrl
if ($LASTEXITCODE -ne 0) {
  throw "Setting origin remote failed."
}

$branch = (& git -C $packageRoot rev-parse --abbrev-ref HEAD).Trim()
if (-not $branch) {
  throw "Could not determine package branch."
}
& git -C $packageRoot branch --set-upstream-to="origin/$branch" $branch | Out-Host
if ($LASTEXITCODE -ne 0) {
  throw "Setting upstream branch failed."
}

foreach ($extra in @("runtime", "Manual", "cfs-public-supabase.env", ".cfs-build-info.json")) {
  $source = Join-Path $runtimeSource $extra
  if (Test-Path -LiteralPath $source) {
    Copy-Item -LiteralPath $source -Destination (Join-Path $packageRoot $extra) -Recurse -Force
  }
}
if (-not $ExcludeBundledNode) {
  Copy-Item -LiteralPath (Join-Path $runtimeSource ".cfs-runtime") -Destination (Join-Path $packageRoot ".cfs-runtime") -Recurse -Force
}

# Safety net: the runtime-source builder sanitizes the bundled PortableGit config,
# but re-check here so a stale runtime source cannot ship an absolute-path
# credential helper (helper = !"C:/.../git-credential-manager.exe"), which breaks
# Git auth on every recipient machine.
$bundledGitConfig = Join-Path $packageRoot ".cfs-runtime\git\etc\gitconfig"
if (Test-Path -LiteralPath $bundledGitConfig) {
  $gitConfigLines = Get-Content -LiteralPath $bundledGitConfig -Encoding UTF8
  $gitConfigChanged = $false
  $gitConfigRepaired = foreach ($line in $gitConfigLines) {
    if ($line -match '^\s*helper\s*=\s*!' -and $line -match 'git-credential-manager') {
      $gitConfigChanged = $true
      "`thelper = manager"
    } else {
      $line
    }
  }
  if ($gitConfigChanged) {
    Set-Content -LiteralPath $bundledGitConfig -Value $gitConfigRepaired -Encoding UTF8
    Write-Host "Sanitized bundled git credential helper: $bundledGitConfig"
  }
}

if (Test-Path -LiteralPath (Join-Path $packageRoot ".env.local")) {
  throw "Refusing to package .env.local."
}

$trackedStatus = (& git -C $packageRoot status --short --untracked-files=no) -join "`n"
if (-not [string]::IsNullOrWhiteSpace($trackedStatus)) {
  throw "Tracked package tree is dirty:`n$trackedStatus"
}
$packageGitCommit = (& git -C $packageRoot rev-parse HEAD).Trim()

$manifest = Get-Content -LiteralPath (Join-Path $runtimeSource "RELEASE_PACKAGE_MANIFEST.json") -Raw | ConvertFrom-Json
$manifest.GitCommit = $packageGitCommit
$manifest | Add-Member -MemberType NoteProperty -Name IncludesGitMetadata -Value $true -Force
$manifest | Add-Member -MemberType NoteProperty -Name GitRemote -Value $RemoteUrl -Force
$manifest | Add-Member -MemberType NoteProperty -Name DistributionMode -Value "GitManagedZip" -Force
$manifest | Add-Member -MemberType NoteProperty -Name IncludesBundledGit -Value (-not [bool]$ExcludeBundledGit) -Force
$manifest.Excluded = @("data", ".env.local", "raw .next", "root node_modules", "artifacts", "test-results", "playwright-report")
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $packageRoot "RELEASE_PACKAGE_MANIFEST.json") -Encoding UTF8

New-ZipArchiveIncludingHidden -SourceDirectory $packageRoot -ArchivePath $archivePath
$zip = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  $hasGitHead = [bool]($zip.Entries | Where-Object { $_.FullName -eq ".git/HEAD" } | Select-Object -First 1)
} finally {
  $zip.Dispose()
}
if (-not $hasGitHead) {
  throw "Zip does not contain .git/HEAD."
}

[PSCustomObject]@{
  PackageDirectory = $packageRoot
  Archive = $archivePath
  GitCommit = $packageGitCommit
  GitRemote = (& git -C $packageRoot remote get-url origin).Trim()
  GitUpstream = (& git -C $packageRoot rev-parse --abbrev-ref --symbolic-full-name "@{u}").Trim()
  IncludesGitMetadata = $true
  IncludesSharedDatabaseConfig = [bool]$IncludeSharedDatabaseConfig
  IncludesStandaloneRuntime = $true
  IncludesBundledNode = -not [bool]$ExcludeBundledNode
  IncludesBundledGit = -not [bool]$ExcludeBundledGit
  TrackedStatusClean = [string]::IsNullOrWhiteSpace($trackedStatus)
  ZipContainsGitHead = $hasGitHead
  ArchiveSizeMB = [Math]::Round((Get-Item -LiteralPath $archivePath).Length / 1MB, 1)
} | ConvertTo-Json
