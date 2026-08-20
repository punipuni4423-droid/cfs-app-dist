param(
  [Parameter(Mandatory = $true)]
  [string]$Path,
  [switch]$AllowBundledRuntime
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$target = (Resolve-Path -LiteralPath $Path).Path
$violations = New-Object System.Collections.Generic.List[string]
$forbiddenDirectoryNames = @(
  'data',
  '.git',
  '.next',
  '.cfs-runtime',
  'artifacts',
  'node_modules',
  'playwright-report',
  'test-results'
)
$forbiddenDirectories = Get-ChildItem -LiteralPath $target -Recurse -Force -Directory -ErrorAction Stop |
  Where-Object {
    if ($_.Name -notin $forbiddenDirectoryNames) {
      return $false
    }
    if ($AllowBundledRuntime) {
      $relativePath = $_.FullName.Substring($target.Length).TrimStart('\')
      if ($relativePath -eq '.cfs-runtime' -or
          $relativePath.StartsWith('.cfs-runtime\', [System.StringComparison]::OrdinalIgnoreCase) -or
          $relativePath -eq 'runtime\node_modules' -or
          $relativePath.StartsWith('runtime\node_modules\', [System.StringComparison]::OrdinalIgnoreCase) -or
          $relativePath -eq 'runtime\.next' -or
          $relativePath.StartsWith('runtime\.next\', [System.StringComparison]::OrdinalIgnoreCase)) {
        return $false
      }
    }
    return $true
  }
foreach ($directory in $forbiddenDirectories) {
  $violations.Add("Forbidden directory found: $($directory.FullName)")
}

$forbiddenFiles = Get-ChildItem -LiteralPath $target -Recurse -Force -File -ErrorAction Stop |
  Where-Object { $_.Name -in @('.env.local', '.env.production', '.env.development') }
foreach ($file in $forbiddenFiles) {
  $violations.Add("Forbidden environment file: $($file.FullName)")
}

$textFiles = @(Get-ChildItem -LiteralPath $target -Recurse -Force -File -ErrorAction Stop |
  Where-Object { $_.Length -le 5MB -and ($_.Name -like '.env*' -or $_.Extension -in @('.env', '.txt', '.md', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.ps1', '.cmd', '.bat', '.vbs', '.yml', '.yaml')) })
foreach ($file in $textFiles) {
  $content = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction Stop
  if ($content -match '(?im)^\s*(SUPABASE_SERVICE_ROLE_KEY|SERVICE_ROLE_KEY)\s*=\s*(?!\s*(?:$|#|<[^>]+>|""|\x27\x27))\S+') {
    $violations.Add("Service Role assignment found: $($file.FullName)")
  }
  if ($content -match '(?i)sb_secret_[a-z0-9_-]{12,}') {
    $violations.Add("Supabase secret key marker found: $($file.FullName)")
  }
}

# Bundled PortableGit configs are exempt from the directory checks above, so probe
# them directly: an absolute-path credential helper written by GCM "configure" on
# the build machine breaks Git auth on every other extract location.
$bundledGitConfigs = Get-ChildItem -LiteralPath $target -Recurse -Force -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -eq 'gitconfig' -and $_.FullName -match '\\\.cfs-runtime\\' }
foreach ($gitConfigFile in $bundledGitConfigs) {
  $gitConfigContent = Get-Content -LiteralPath $gitConfigFile.FullName -Raw -ErrorAction Stop
  if ($gitConfigContent -match '(?im)^\s*helper\s*=\s*!.*git-credential-manager') {
    $violations.Add("Bundled gitconfig contains an absolute-path credential helper (breaks on recipients): $($gitConfigFile.FullName)")
  }
}

if ($violations.Count -gt 0) {
  $violations | ForEach-Object { Write-Error $_ }
  throw "Release secret audit failed."
}

[PSCustomObject]@{
  Path = $target
  FilesScanned = $textFiles.Count
  Result = 'pass'
} | ConvertTo-Json
