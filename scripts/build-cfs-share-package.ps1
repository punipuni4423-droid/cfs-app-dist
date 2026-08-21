param(
  [string]$OutputDirectory = (Join-Path (Get-Location) "artifacts\\share-packages"),
  [string]$PackageName = "CFS-Common",
  [switch]$IncludeSharedDatabaseConfig,
  [switch]$SkipBuild,
  [switch]$IncludeBundledGit,
  [switch]$SkipArchive,
  [switch]$ExcludeBundledNode
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$appRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$packageRoot = Join-Path $OutputDirectory "$PackageName-$stamp"
$archivePath = "$packageRoot.zip"
$gitCommit = (& git -C $appRoot rev-parse HEAD).Trim()
$buildDistDir = ".next-share-package"

if (Test-Path -LiteralPath $packageRoot) {
  Remove-Item -LiteralPath $packageRoot -Recurse -Force
}
if (Test-Path -LiteralPath $archivePath) {
  Remove-Item -LiteralPath $archivePath -Force
}
New-Item -ItemType Directory -Force -Path $packageRoot | Out-Null

function Clear-PackageBuildOutput {
  param(
    [string]$RootPath,
    [string]$DistDir
  )
  $rootFullPath = [System.IO.Path]::GetFullPath($RootPath)
  $distPath = [System.IO.Path]::GetFullPath((Join-Path $rootFullPath $DistDir))
  $expectedPrefix = $rootFullPath.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  if (-not $distPath.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clear Next build output outside the app folder: $distPath"
  }
  if (Test-Path -LiteralPath $distPath) {
    Remove-Item -LiteralPath $distPath -Recurse -Force
  }
}

function Repair-BundledGitConfig {
  param([string]$GitHome)
  # GCM "configure" on the build machine writes an absolute-path credential helper
  # (helper = !"C:/.../git-credential-manager.exe") into the bundled PortableGit
  # system config. That path breaks on every other extract location, so recipients
  # lose Git auth entirely. Rewrite it to the portable "manager" form, which Git
  # for Windows resolves from its own mingw64\bin regardless of the install path.
  $configPath = Join-Path $GitHome "etc\gitconfig"
  if (-not (Test-Path -LiteralPath $configPath)) {
    return
  }
  $lines = Get-Content -LiteralPath $configPath -Encoding UTF8
  $changed = $false
  $repaired = foreach ($line in $lines) {
    if ($line -match '^\s*helper\s*=\s*!' -and $line -match 'git-credential-manager') {
      $changed = $true
      "`thelper = manager"
    } else {
      $line
    }
  }
  if ($changed) {
    Set-Content -LiteralPath $configPath -Value $repaired -Encoding UTF8
    Write-Host "Sanitized bundled git credential helper: $configPath"
  }
}

if (-not $SkipBuild) {
  Push-Location $appRoot
  $previousNextDistDir = $env:NEXT_DIST_DIR
  $tsconfigPath = Join-Path $appRoot "tsconfig.json"
  $tsconfigBeforeBuild = if (Test-Path -LiteralPath $tsconfigPath) { [System.IO.File]::ReadAllText($tsconfigPath) } else { $null }
  try {
    Clear-PackageBuildOutput -RootPath $appRoot -DistDir $buildDistDir
    $env:NEXT_DIST_DIR = $buildDistDir
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) {
      throw "CFS production build failed."
    }
  } finally {
    if ($null -eq $previousNextDistDir) {
      Remove-Item Env:NEXT_DIST_DIR -ErrorAction SilentlyContinue
    } else {
      $env:NEXT_DIST_DIR = $previousNextDistDir
    }
    if ($null -ne $tsconfigBeforeBuild) {
      $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
      [System.IO.File]::WriteAllText($tsconfigPath, $tsconfigBeforeBuild, $utf8NoBom)
    }
    Pop-Location
  }
}

$standaloneSource = Join-Path $appRoot "$buildDistDir\standalone"
$standaloneServer = Join-Path $standaloneSource "server.js"
if (-not (Test-Path -LiteralPath $standaloneServer)) {
  throw "Next.js standalone runtime was not found. Run npm run build after enabling output: 'standalone'."
}

$directories = @("app", "public")
$shareScripts = @(
  "auth-redirect-helper.mjs",
  "clean-reinstall-cfs-app.ps1",
  "ensure-git-runtime.ps1",
  "ensure-node-runtime.ps1",
  "launch-cfs-app.ps1",
  "start-cfs-background-server.ps1",
  "test-cfs-instance.ps1",
  "update-cfs-app.ps1",
  "write-cfs-build-info.mjs"
)
$files = @(
  ".env.example",
  "eslint.config.mjs",
  "next.config.ts",
  "package-lock.json",
  "package.json",
  "postcss.config.mjs",
  "CREATE_DESKTOP_SHORTCUT.vbs",
  "CLEAN_REINSTALL_CFS_APP.cmd",
  "CFS_CLEAN_REINSTALL_GUIDE_JA.md",
  "LAUNCH_CFS_APP.cmd",
  "LAUNCH_CFS_APP.vbs",
  "START_CFS_APP.bat",
  "START_CFS_APP_CONSOLE.bat",
  "PDU_SHARED_DEFAULTS_JA.md",
  "SHARE_README_JA.md",
  "tsconfig.json"
)

foreach ($directory in $directories) {
  Copy-Item -LiteralPath (Join-Path $appRoot $directory) -Destination $packageRoot -Recurse -Force
}

$iconConceptDirectory = Join-Path $packageRoot "public\app-icon-concepts-20260714"
if (Test-Path -LiteralPath $iconConceptDirectory) {
  Remove-Item -LiteralPath $iconConceptDirectory -Recurse -Force
}

if ($shareScripts.Count -gt 0) {
  New-Item -ItemType Directory -Force -Path (Join-Path $packageRoot "scripts") | Out-Null
  foreach ($script in $shareScripts) {
    Copy-Item -LiteralPath (Join-Path $appRoot "scripts\$script") -Destination (Join-Path $packageRoot "scripts") -Force
  }
}
foreach ($file in $files) {
  Copy-Item -LiteralPath (Join-Path $appRoot $file) -Destination $packageRoot -Force
}

$runtimeTarget = Join-Path $packageRoot "runtime"
Copy-Item -LiteralPath $standaloneSource -Destination $runtimeTarget -Recurse -Force

# Safety net: the Next file tracer has pulled package staging folders into the
# standalone output before (deeply nested paths break Windows zip extraction).
# Remove any such stray directories from the packaged runtime.
foreach ($strayName in @("artifacts", ".next-share-package")) {
  Get-ChildItem -LiteralPath $runtimeTarget -Recurse -Force -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq $strayName } |
    Sort-Object { $_.FullName.Length } -Descending |
    ForEach-Object {
      if (Test-Path -LiteralPath $_.FullName) {
        Write-Host "Pruned stray runtime directory: $($_.FullName)"
        Remove-Item -LiteralPath $_.FullName -Recurse -Force
      }
    }
}
foreach ($runtimeBlockedPath in @("data", "artifacts", ".git", ".env.local", ".env.production", ".env.development")) {
  $blockedTarget = Join-Path $runtimeTarget $runtimeBlockedPath
  if (Test-Path -LiteralPath $blockedTarget) {
    Remove-Item -LiteralPath $blockedTarget -Recurse -Force
  }
}

$staticSource = Join-Path $appRoot "$buildDistDir\static"
if (Test-Path -LiteralPath $staticSource) {
  $staticTargetParent = Join-Path $runtimeTarget $buildDistDir
  New-Item -ItemType Directory -Force -Path $staticTargetParent | Out-Null
  Copy-Item -LiteralPath $staticSource -Destination $staticTargetParent -Recurse -Force
}

$runtimePublicTarget = Join-Path $runtimeTarget "public"
if (Test-Path -LiteralPath $runtimePublicTarget) {
  Remove-Item -LiteralPath $runtimePublicTarget -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $appRoot "public") -Destination $runtimeTarget -Recurse -Force
$runtimeIconConceptDirectory = Join-Path $runtimeTarget "public\app-icon-concepts-20260714"
if (Test-Path -LiteralPath $runtimeIconConceptDirectory) {
  Remove-Item -LiteralPath $runtimeIconConceptDirectory -Recurse -Force
}

$buildInfoSource = Join-Path $appRoot ".cfs-build-info.json"
if (Test-Path -LiteralPath $buildInfoSource) {
  Copy-Item -LiteralPath $buildInfoSource -Destination (Join-Path $packageRoot ".cfs-build-info.json") -Force
  Copy-Item -LiteralPath $buildInfoSource -Destination (Join-Path $runtimeTarget ".cfs-build-info.json") -Force
}

$bundledGitExe = $null
if ($IncludeBundledGit) {
  $bundledGitExe = (& (Join-Path $appRoot "scripts\ensure-git-runtime.ps1") -AppRoot $appRoot -AppLocalOnly | Select-Object -Last 1).Trim()
  if (-not $bundledGitExe -or -not (Test-Path -LiteralPath $bundledGitExe)) {
    throw "Bundled Git runtime could not be prepared."
  }
}

if (-not $ExcludeBundledNode) {
  $nodeRuntime = (& (Join-Path $appRoot "scripts\ensure-node-runtime.ps1") -AppRoot $appRoot | Select-Object -Last 1).Trim()
  if (-not $nodeRuntime -or -not (Test-Path -LiteralPath (Join-Path $nodeRuntime "node.exe"))) {
    throw "Bundled Node.js runtime could not be prepared."
  }
  $nodeRuntimeRoot = Split-Path -Parent $nodeRuntime
  Copy-Item -LiteralPath $nodeRuntimeRoot -Destination (Join-Path $packageRoot ".cfs-runtime") -Recurse -Force
  Repair-BundledGitConfig -GitHome (Join-Path $packageRoot ".cfs-runtime\git")
} elseif ($IncludeBundledGit) {
  $gitTarget = Join-Path $packageRoot ".cfs-runtime\git"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $gitTarget) | Out-Null
  Copy-Item -LiteralPath (Join-Path $appRoot ".cfs-runtime\git") -Destination $gitTarget -Recurse -Force
  Repair-BundledGitConfig -GitHome $gitTarget
}

function Read-EnvFileValues([string]$Path) {
  $values = @{}
  if (-not (Test-Path -LiteralPath $Path)) {
    return $values
  }
  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) {
      continue
    }
    $parts = $trimmed -split "=", 2
    if ($parts.Count -ne 2) {
      continue
    }
    $values[$parts[0].Trim()] = $parts[1].Trim()
  }
  return $values
}

if ($IncludeSharedDatabaseConfig) {
  $envValues = Read-EnvFileValues (Join-Path $appRoot ".env.local")
  $sharedMode = if ($envValues.ContainsKey("CFS_SHARING_MODE")) { $envValues["CFS_SHARING_MODE"] } else { $env:CFS_SHARING_MODE }
  $supabaseUrl = if ($envValues.ContainsKey("SUPABASE_URL")) { $envValues["SUPABASE_URL"] } else { $env:SUPABASE_URL }
  $publishableKey = if ($envValues.ContainsKey("SUPABASE_PUBLISHABLE_KEY")) { $envValues["SUPABASE_PUBLISHABLE_KEY"] } else { $env:SUPABASE_PUBLISHABLE_KEY }
  $functionName = if ($envValues.ContainsKey("CFS_SUPABASE_FUNCTION_NAME")) { $envValues["CFS_SUPABASE_FUNCTION_NAME"] } else { $env:CFS_SUPABASE_FUNCTION_NAME }

  if ($sharedMode -ne "supabase" -or -not $supabaseUrl -or -not $publishableKey -or -not $functionName) {
    throw "Shared database config was requested, but public Supabase values are incomplete."
  }

  @(
    "# CFS shared database public configuration."
    "# This file contains only browser-publishable values. Do not add service-role keys or client secrets."
    "CFS_SHARING_MODE=supabase"
    "SUPABASE_URL=$supabaseUrl"
    "SUPABASE_PUBLISHABLE_KEY=$publishableKey"
    "CFS_SUPABASE_FUNCTION_NAME=$functionName"
  ) | Set-Content -LiteralPath (Join-Path $packageRoot "cfs-public-supabase.env") -Encoding UTF8
}

$manualDirectory = Join-Path $packageRoot "Manual"
New-Item -ItemType Directory -Force -Path $manualDirectory | Out-Null
$manualSource = Join-Path $appRoot "docs\CFS_USAGE_GUIDE_COMMON_20260807.html"
Copy-Item -LiteralPath $manualSource -Destination (Join-Path $manualDirectory "CFS_USAGE_GUIDE_COMMON_20260807.html") -Force
Copy-Item -LiteralPath $manualSource -Destination (Join-Path $manualDirectory "index.html") -Force
$authTroubleshootingSource = Join-Path $appRoot "docs\CFS_AUTH_REDIRECT_TROUBLESHOOTING_20260807.md"
if (Test-Path -LiteralPath $authTroubleshootingSource) {
  Copy-Item -LiteralPath $authTroubleshootingSource -Destination (Join-Path $manualDirectory "CFS_AUTH_REDIRECT_TROUBLESHOOTING_20260807.md") -Force
}
$launchTroubleshootingSource = Join-Path $appRoot "docs\CFS_LAUNCH_TROUBLESHOOTING_20260807.md"
if (Test-Path -LiteralPath $launchTroubleshootingSource) {
  Copy-Item -LiteralPath $launchTroubleshootingSource -Destination (Join-Path $manualDirectory "CFS_LAUNCH_TROUBLESHOOTING_20260807.md") -Force
}
$manualAssetsSource = Join-Path $appRoot "docs\assets\cfs_usage_common_20260807"
if (Test-Path -LiteralPath $manualAssetsSource) {
  $manualAssetsTarget = Join-Path $manualDirectory "assets\cfs_usage_common_20260807"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $manualAssetsTarget) | Out-Null
  Copy-Item -LiteralPath $manualAssetsSource -Destination (Split-Path -Parent $manualAssetsTarget) -Recurse -Force
}

$manifest = [PSCustomObject]@{
  PackageName = $PackageName
  CreatedAt = (Get-Date).ToString("o")
  GitCommit = $gitCommit
  IncludesProjectData = $false
  IncludesSharedDatabaseConfig = [bool]$IncludeSharedDatabaseConfig
  IncludesHtmlManual = $true
  Manual = "Manual\CFS_USAGE_GUIDE_COMMON_20260807.html"
  AuthRedirectTroubleshooting = "Manual\CFS_AUTH_REDIRECT_TROUBLESHOOTING_20260807.md"
  LaunchTroubleshooting = "Manual\CFS_LAUNCH_TROUBLESHOOTING_20260807.md"
  IncludesManualScreenshots = $true
  IncludesShortcutIcon = $true
  IncludesStandaloneRuntime = $true
  IncludesBundledNode = -not [bool]$ExcludeBundledNode
  IncludesBundledGit = [bool]$IncludeBundledGit
  CleanReinstallGuide = "CFS_CLEAN_REINSTALL_GUIDE_JA.md"
  CleanReinstallLauncher = "CLEAN_REINSTALL_CFS_APP.cmd"
  Runtime = "runtime\server.js"
  BuildInfo = ".cfs-build-info.json"
  Excluded = @("data", ".env.local", ".git", "raw .next", "root node_modules", "artifacts", "test-results", "playwright-report")
}
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $packageRoot "RELEASE_PACKAGE_MANIFEST.json") -Encoding UTF8

& (Join-Path $appRoot "scripts\audit-release-secrets.ps1") -Path $packageRoot -AllowBundledRuntime

if (-not $SkipArchive) {
  Compress-Archive -Path (Join-Path $packageRoot "*") -DestinationPath $archivePath -CompressionLevel Optimal
  & (Join-Path $appRoot "scripts\inspect-release-archive.ps1") -ArchivePath $archivePath -AllowBundledRuntime
}

[PSCustomObject]@{
  PackageDirectory = $packageRoot
  Archive = if ($SkipArchive) { $null } else { $archivePath }
  GitCommit = $gitCommit
  IncludesProjectData = $false
  IncludesSharedDatabaseConfig = [bool]$IncludeSharedDatabaseConfig
  PduVaPerPduDefault = 3.3
  IncludesHtmlManual = $true
  Manual = "Manual\CFS_USAGE_GUIDE_COMMON_20260807.html"
  AuthRedirectTroubleshooting = "Manual\CFS_AUTH_REDIRECT_TROUBLESHOOTING_20260807.md"
  LaunchTroubleshooting = "Manual\CFS_LAUNCH_TROUBLESHOOTING_20260807.md"
  IncludesManualScreenshots = $true
  IncludesShortcutIcon = $true
  IncludesStandaloneRuntime = $true
  IncludesBundledNode = -not [bool]$ExcludeBundledNode
  IncludesBundledGit = [bool]$IncludeBundledGit
  CleanReinstallGuide = "CFS_CLEAN_REINSTALL_GUIDE_JA.md"
  CleanReinstallLauncher = "CLEAN_REINSTALL_CFS_APP.cmd"
  Runtime = "runtime\server.js"
  BuildInfo = ".cfs-build-info.json"
} | ConvertTo-Json
