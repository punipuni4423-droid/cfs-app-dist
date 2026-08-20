param(
  [string]$AppRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [switch]$NoStart,
  [switch]$NoShortcut,
  [switch]$SkipProcessStop,
  [switch]$SkipOldFolderPrompt
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$appRootFull = [System.IO.Path]::GetFullPath($AppRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
$startupDir = Join-Path $appRootFull "artifacts\startup"
New-Item -ItemType Directory -Force -Path $startupDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $startupDir "clean-reinstall-$stamp.log"

function Write-Step {
  param([Parameter(Mandatory = $true)][string]$Message)
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Write-Host $line
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

function Same-Path {
  param([string]$Left, [string]$Right)
  if (-not $Left -or -not $Right) { return $false }
  $leftFull = [System.IO.Path]::GetFullPath($Left).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
  $rightFull = [System.IO.Path]::GetFullPath($Right).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
  return [System.StringComparer]::OrdinalIgnoreCase.Equals($leftFull, $rightFull)
}

function Is-AncestorOrChildPath {
  param([string]$Left, [string]$Right)
  $leftFull = [System.IO.Path]::GetFullPath($Left).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
  $rightFull = [System.IO.Path]::GetFullPath($Right).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
  $leftPrefix = $leftFull + [System.IO.Path]::DirectorySeparatorChar
  $rightPrefix = $rightFull + [System.IO.Path]::DirectorySeparatorChar
  return $rightFull.StartsWith($leftPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
    $leftFull.StartsWith($rightPrefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-CfsFolder {
  param([string]$Path)
  if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Container)) { return $false }
  return (Test-Path -LiteralPath (Join-Path $Path "LAUNCH_CFS_APP.cmd")) -or
    (Test-Path -LiteralPath (Join-Path $Path "START_CFS_APP.bat"))
}

function Stop-OldCfsProcesses {
  $currentPid = $PID
  $processes = Get-CimInstance Win32_Process |
    Where-Object {
      if ($_.ProcessId -eq $currentPid) { return $false }
      if ($_.Name -notin @("node.exe", "cmd.exe", "powershell.exe", "pwsh.exe", "wscript.exe", "cscript.exe")) { return $false }
      $commandLine = [string]$_.CommandLine
      if (-not $commandLine) { return $false }
      $looksLikeCfs = $commandLine -match '(?i)CFS|CFS-CircuitScope|cfs-app'
      $looksLikeLauncher = $commandLine -match '(?i)START_CFS_APP|LAUNCH_CFS_APP|runtime\\server\.js|auth-redirect-helper\.mjs|next(?:\.cmd)?\s+start'
      return $looksLikeCfs -and $looksLikeLauncher
    }

  foreach ($process in $processes) {
    try {
      Write-Step ("Stopping old CFS process PID {0}: {1}" -f $process.ProcessId, $process.Name)
      Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
    } catch {
      Write-Step ("Could not stop PID {0}: {1}" -f $process.ProcessId, $_.Exception.Message)
    }
  }
}

function Get-CfsShortcutRoots {
  if ($NoShortcut) { return @() }
  $roots = New-Object System.Collections.Generic.List[string]
  try {
    $shell = New-Object -ComObject WScript.Shell
    $locations = @(
      [Environment]::GetFolderPath("DesktopDirectory"),
      [Environment]::GetFolderPath("Programs")
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) }

    foreach ($location in $locations) {
      Get-ChildItem -LiteralPath $location -Filter "CFS App*.lnk" -File -ErrorAction SilentlyContinue | ForEach-Object {
        try {
          $shortcut = $shell.CreateShortcut($_.FullName)
          $candidate = $shortcut.WorkingDirectory
          if (-not $candidate -and $shortcut.TargetPath) {
            $candidate = Split-Path -Parent $shortcut.TargetPath
          }
          if ($candidate -and (Test-CfsFolder -Path $candidate) -and -not (Same-Path $candidate $appRootFull)) {
            $roots.Add(([System.IO.Path]::GetFullPath($candidate).TrimEnd([System.IO.Path]::DirectorySeparatorChar)))
          }
        } catch {
          Write-Step ("Could not read shortcut {0}: {1}" -f $_.FullName, $_.Exception.Message)
        }
      }
    }
  } catch {
    Write-Step ("Could not inspect existing shortcuts: {0}" -f $_.Exception.Message)
  }
  return $roots | Sort-Object -Unique
}

function Rename-OldFolder {
  param([Parameter(Mandatory = $true)][string]$OldPath)

  $oldFull = [System.IO.Path]::GetFullPath($OldPath).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
  if (-not (Test-CfsFolder -Path $oldFull)) {
    Write-Step "Skipped non-CFS folder: $oldFull"
    return
  }
  if (Same-Path $oldFull $appRootFull) {
    Write-Step "Skipped current folder: $oldFull"
    return
  }
  if (Is-AncestorOrChildPath $oldFull $appRootFull) {
    Write-Step "Skipped related parent/child folder for safety: $oldFull"
    return
  }

  $parent = Split-Path -Parent $oldFull
  $leaf = Split-Path -Leaf $oldFull
  $target = Join-Path $parent ("{0}_old_{1}" -f $leaf, $stamp)
  $targetFull = [System.IO.Path]::GetFullPath($target)
  $parentPrefix = [System.IO.Path]::GetFullPath($parent).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  if (-not $targetFull.StartsWith($parentPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to move outside the old folder parent: $targetFull"
  }
  if (Test-Path -LiteralPath $targetFull) {
    throw "Target already exists: $targetFull"
  }

  Write-Step "Renaming old CFS folder:"
  Write-Step "  From: $oldFull"
  Write-Step "  To:   $targetFull"
  Move-Item -LiteralPath $oldFull -Destination $targetFull
}

function Create-CfsShortcut {
  if ($NoShortcut) { return }
  try {
    $shell = New-Object -ComObject WScript.Shell
    $targets = @(
      (Join-Path ([Environment]::GetFolderPath("DesktopDirectory")) "CFS App.lnk"),
      (Join-Path ([Environment]::GetFolderPath("Programs")) "CFS App.lnk")
    )
    $launchTarget = Join-Path $appRootFull "LAUNCH_CFS_APP.cmd"
    $iconPath = Join-Path $appRootFull "public\cfs-app-icon.ico"
    foreach ($target in $targets) {
      $shortcutDirectory = Split-Path -Parent $target
      if (-not (Test-Path -LiteralPath $shortcutDirectory -PathType Container)) {
        New-Item -ItemType Directory -Force -Path $shortcutDirectory | Out-Null
      }
      $shortcut = $shell.CreateShortcut($target)
      $shortcut.TargetPath = $launchTarget
      $shortcut.WorkingDirectory = $appRootFull
      if (Test-Path -LiteralPath $iconPath) {
        $shortcut.IconLocation = "$iconPath,0"
      }
      $shortcut.Description = "Start CFS App from $appRootFull"
      $shortcut.Save()
      Write-Step "Created shortcut: $target"
    }
  } catch {
    Write-Step ("Could not create shortcuts automatically: {0}" -f $_.Exception.Message)
    Write-Step "Use LAUNCH_CFS_APP.cmd in the new folder directly."
  }
}

if (-not (Test-Path -LiteralPath (Join-Path $appRootFull "LAUNCH_CFS_APP.cmd") -PathType Leaf)) {
  throw "LAUNCH_CFS_APP.cmd was not found in $appRootFull"
}

Write-Step "CFS clean reinstall helper started."
Write-Step "New app folder: $appRootFull"

if ($SkipProcessStop) {
  Write-Step "Skipped old CFS process stop by option."
} else {
  Stop-OldCfsProcesses
}

$oldRoots = @(Get-CfsShortcutRoots)
if ($oldRoots.Count -gt 0) {
  Write-Step "Detected old CFS shortcut target folder(s):"
  foreach ($root in $oldRoots) { Write-Step "  $root" }
  if (-not $SkipOldFolderPrompt) {
    Write-Host ""
    Write-Host "Old CFS folder(s) were detected from existing shortcuts."
    Write-Host "They can be renamed to *_old_$stamp. No permanent deletion is performed."
    $answer = Read-Host "Rename the detected old folder(s)? Type Y to rename, or press Enter to skip"
    if ($answer -match '(?i)^y(?:es)?$') {
      foreach ($root in $oldRoots) {
        try {
          Rename-OldFolder -OldPath $root
        } catch {
          Write-Step ("Could not rename {0}: {1}" -f $root, $_.Exception.Message)
        }
      }
    } else {
      Write-Step "Skipped old folder rename by user choice."
    }
  } else {
    Write-Step "Skipped old folder prompt by option."
  }
} else {
  Write-Step "No older CFS shortcut target folder was detected."
}

Create-CfsShortcut

if (-not $NoStart) {
  Write-Step "Starting CFS App from the new folder."
  Start-Process -FilePath (Join-Path $appRootFull "LAUNCH_CFS_APP.cmd") -WorkingDirectory $appRootFull
} else {
  Write-Step "Skipped app start by option."
}

Write-Step "CFS clean reinstall helper completed."
