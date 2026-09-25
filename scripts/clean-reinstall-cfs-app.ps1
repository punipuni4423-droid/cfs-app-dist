param(
  [string]$AppRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$OldAppRoot,
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

function Resolve-CfsReinstallRoot {
  param([string]$Path)
  if (-not $Path -or $Path -notmatch '^(?:[a-zA-Z]:[\\/]|\\\\[^\\]+\\[^\\]+)') { throw 'An absolute app root is required.' }
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
  $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
  if (-not $item.PSIsContainer) { throw 'App root must be a directory.' }
  while ($null -ne $item) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse app paths are not supported.' }
    $item = $item.Parent
  }
  return $full
}

function Resolve-CfsOldRoots {
  $newRoot = Resolve-CfsReinstallRoot $appRootFull
  $candidates = @(if ($OldAppRoot) { $OldAppRoot } else { Get-CfsShortcutRoots })
  if ($candidates.Count -eq 0) { return @() }
  $resolved = @()
  foreach ($candidate in $candidates) {
    $oldRoot = Resolve-CfsReinstallRoot $candidate
    if ($oldRoot -match '(?i)(^|\\)\.update-qa(\\|$)' -or
        $oldRoot -match '(?i)^C:\\dev\\AI\\CFS\\cfs-app-verify(?:\\|$)' -or
        (Same-Path $oldRoot $newRoot) -or (Is-AncestorOrChildPath $oldRoot $newRoot)) {
      throw 'Protected, current, or related app root cannot be stopped or renamed.'
    }
    if (-not (Test-CfsFolder $oldRoot)) { throw 'The old root is not a CFS installation.' }
    $resolved += $oldRoot
  }
  return @($resolved | Sort-Object -Unique)
}

function Split-CfsReinstallArguments {
  param([string]$Line)
  # Only simple Windows argv is accepted. Complex shell expressions are refused.
  $parts = [regex]::Matches($Line, '"([^"\r\n]*)"|([^\s"]+)')
  $end = 0
  $values = @()
  foreach ($part in $parts) {
    if ($Line.Substring($end, $part.Index - $end).Trim()) { throw 'Unverifiable process quoting.' }
    $values += if ($part.Groups[1].Success) { $part.Groups[1].Value } else { $part.Groups[2].Value }
    $end = $part.Index + $part.Length
  }
  if ($Line.Substring($end).Trim()) { throw 'Unverifiable process quoting.' }
  return ,$values
}

function Test-CfsOldRootProcess {
  param($Process, [string[]]$Roots)
  if ($Process.ProcessId -eq $PID -or $Process.Name -notin @('node.exe','cmd.exe','powershell.exe','pwsh.exe')) { return $false }
  $line = [string]$Process.CommandLine
  if ([string]::IsNullOrWhiteSpace($line)) { return $false }
  $ownedText = $false
  foreach ($root in $Roots) {
    if ($line.Replace('/', '\').IndexOf($root + '\', [StringComparison]::OrdinalIgnoreCase) -ge 0) { $ownedText = $true }
  }
  # START_CFS_APP.bat keeps this exact redirect wrapper alive with the helper.
  # Do not accept arbitrary shell expressions that merely mention an old path.
  if ($Process.Name -eq 'cmd.exe') {
    foreach ($root in $Roots) {
      $helper = [regex]::Escape((Join-Path $root 'scripts\auth-redirect-helper.mjs'))
      $target = [regex]::Escape((Join-Path $root 'artifacts\startup\auth-redirect-target.json'))
      $log = [regex]::Escape((Join-Path $root 'artifacts\startup\auth-redirect-helper.log'))
      $pattern = '(?i)^(?:"[^"\r\n]*cmd\.exe"|[^\s"]*cmd\.exe)\s+/d\s+/s\s+/c\s+"?(?:node\.exe|"[^"\r\n]*node\.exe")\s+"' + $helper + '"\s+--port\s+[0-9]{1,5}\s+--target-file\s+"' + $target + '"\s+--target\s+"http://localhost:[0-9]{1,5}"\s+>>\s+"' + $log + '"\s+2>&1"?\s*$'
      if ($line -match $pattern) {
        if ($null -eq $Process.CreationDate) { throw 'Old helper wrapper identity is unavailable.' }
        return $true
      }
    }
  }
  # Nested cmd /s /c adds an extra pair of quotes around the entire command.
  if ($Process.Name -eq 'cmd.exe' -and $line -match '(?is)^(.*?\s/[ck]\s+)"(".*)"\s*$') { $line = $Matches[1] + $Matches[2] }
  try { $argv = Split-CfsReinstallArguments $line } catch { if ($ownedText) { throw }; return $false }
  $entry = $null
  if ($Process.Name -eq 'node.exe' -and $argv.Count -gt 1) {
    $index = if ($argv[1] -eq '--') { 2 } else { 1 }
    if ($argv.Count -gt $index -and -not $argv[$index].StartsWith('-')) { $entry = $argv[$index] }
  } elseif ($Process.Name -eq 'cmd.exe') {
    for ($i = 1; $i -lt $argv.Count - 1; $i++) {
      if ($argv[$i] -in @('/c','/k')) {
        $entry = $argv[$i + 1]
        if ($entry -eq 'call' -and $argv.Count -gt $i + 2) { $entry = $argv[$i + 2] }
        if ($line -match '[&|<>]') { $entry = $null }
        break
      }
    }
  } else {
    for ($i = 1; $i -lt $argv.Count - 1; $i++) { if ($argv[$i] -eq '-File') { $entry = $argv[$i + 1]; break } }
  }
  if ($entry -and $entry -match '^(?:[a-zA-Z]:[\\/]|\\\\)') {
    $full = [IO.Path]::GetFullPath($entry)
    foreach ($root in $Roots) {
      $allowed = if ($Process.Name -eq 'node.exe') { @('runtime\server.js','.next\standalone\server.js','scripts\auth-redirect-helper.mjs') } else { @('START_CFS_APP.bat','START_CFS_APP.cmd','LAUNCH_CFS_APP.cmd','LAUNCH_CFS_APP.bat') }
      foreach ($relative in $allowed) {
        if (Same-Path $full (Join-Path $root $relative)) {
          if ($null -eq $Process.CreationDate) { throw 'Old app process identity is unavailable.' }
          return $true
        }
      }
    }
  }
  if ($ownedText -or ($entry -and $entry -notmatch '^(?:[a-zA-Z]:[\\/]|\\\\)' -and $entry -match '(?i)(?:^|[\\/])(?:server\.js|auth-redirect-helper\.mjs|START_CFS_APP\.(?:bat|cmd)|LAUNCH_CFS_APP\.(?:bat|cmd))$')) {
    throw 'An old or relative app command cannot be attributed safely. Stop it manually before reinstalling.'
  }
  return $false
}

function Get-CfsOldRootProcesses {
  param([string[]]$Roots)
  $inventory = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  $targets = @($inventory | Where-Object { Test-CfsOldRootProcess -Process $_ -Roots $Roots })
  $listeners = @(Get-CfsReinstallListeners)
  $ids = @($targets | ForEach-Object { [int]$_.ProcessId })
  $ports = @(Get-CfsReinstallTargetPorts) + @($listeners | Where-Object { $ids -contains [int]$_.OwningProcess } | Select-Object -ExpandProperty LocalPort)
  foreach ($listener in $listeners) {
    if ($ports -notcontains [int]$listener.LocalPort) { continue }
    $owner = @($inventory | Where-Object { [int]$_.ProcessId -eq [int]$listener.OwningProcess })
    if ($owner.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$owner[0].CommandLine)) {
      throw ('Target port {0} has an unknown process owner; specify -OldAppRoot after stopping that listener.' -f $listener.LocalPort)
    }
  }
  return $targets
}

function Get-CfsReinstallListeners {
  return @(Get-NetTCPConnection -ErrorAction Stop | Where-Object { $_.State -eq 'Listen' })
}

function Get-CfsReinstallTargetPorts {
  # Same defaults as START_CFS_APP.bat; explicit PORT never falls back here.
  foreach ($value in @($(if ($env:PORT) { $env:PORT } else { '3014' }), $(if ($env:CFS_AUTH_REDIRECT_PORT) { $env:CFS_AUTH_REDIRECT_PORT } else { '3000' }))) {
    $number = 0
    if (-not [int]::TryParse($value, [ref]$number) -or $number -lt 1 -or $number -gt 65535) { throw 'Invalid target port; reinstall was refused.' }
    $number
  }
}

function Assert-CfsFirstInstallReady {
  $ports = @(Get-CfsReinstallTargetPorts)
  if (@(Get-CfsReinstallListeners | Where-Object { $ports -contains [int]$_.LocalPort }).Count) {
    throw 'Old app root is unknown and a target port is occupied. Specify -OldAppRoot <absolute path>; the new app was not started.'
  }
  foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction Stop)) {
    if ($process.Name -ne 'node.exe' -or [string]::IsNullOrWhiteSpace([string]$process.CommandLine)) { continue }
    try { $argv = Split-CfsReinstallArguments ([string]$process.CommandLine) } catch {
      if ([string]$process.CommandLine -match '(?i)server\.js|auth-redirect-helper\.mjs') { throw 'An unidentifiable server/helper exists. Specify -OldAppRoot.' }
      continue
    }
    foreach ($entry in @($argv | Select-Object -Skip 1)) {
      if ($entry -notmatch '(?i)(?:^|[\\/])(?:runtime[\\/]server\.js|\.next[\\/]standalone[\\/]server\.js|auth-redirect-helper\.mjs)$') { continue }
      $isNew = $false
      foreach ($relative in @('runtime\server.js','.next\standalone\server.js','scripts\auth-redirect-helper.mjs')) {
        if ($entry -match '^(?:[a-zA-Z]:[\\/]|\\\\)' -and (Same-Path $entry (Join-Path $appRootFull $relative))) { $isNew = $true }
      }
      if (-not $isNew) { throw 'Another server/helper exists but its old root is unknown. Specify -OldAppRoot <absolute path>.' }
    }
  }
  Write-Step 'No old root, no occupied target port, and no other server/helper: proceeding with first installation.'
}

function Stop-OldCfsRootProcesses {
  param([string[]]$Roots, [switch]$CheckOnly)
  $targets = @(Get-CfsOldRootProcesses $Roots)
  if ($CheckOnly -and $targets.Count) { throw 'Old app processes are still running; new startup was refused.' }
  $ids = @($targets | ForEach-Object { [int]$_.ProcessId })
  $ports = @(Get-CfsReinstallListeners | Where-Object { $ids -contains [int]$_.OwningProcess } | Select-Object -ExpandProperty LocalPort -Unique)
  # Launchers first, so they cannot respawn a server while it is being stopped.
  foreach ($target in ($targets | Sort-Object { if ($_.Name -eq 'node.exe') { 1 } else { 0 } })) {
    $current = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$target.ProcessId) -ErrorAction Stop
    if (-not $current) { continue }
    if ($current.CreationDate -ne $target.CreationDate -or $current.CommandLine -cne $target.CommandLine) { throw 'Process identity changed; no stop was issued.' }
    $held = Get-Process -Id $target.ProcessId -ErrorAction Stop
    try {
      $null = $held.Handle
      $start = $held.StartTime.ToUniversalTime()
      $again = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$target.ProcessId) -ErrorAction Stop
      if (-not $again -and $held.HasExited) { continue }
      if (-not $again -or $again.CreationDate -ne $target.CreationDate -or $again.CommandLine -cne $target.CommandLine -or
          [Math]::Abs(($again.CreationDate.ToUniversalTime() - $start).TotalMilliseconds) -ge 1) { throw 'Held process identity changed; no stop was issued.' }
      Write-Step ("Stopping old-root process PID {0}: {1}" -f $target.ProcessId, $target.Name)
      Stop-Process -InputObject $held -Force -ErrorAction Stop
      if (-not $held.WaitForExit(30000)) { throw 'Old app process did not exit within 30 seconds.' }
    } finally { $held.Dispose() }
  }
  if (@(Get-CfsOldRootProcesses $Roots).Count) { throw 'An old app process remains; reinstall was stopped.' }
  if (@(Get-CfsReinstallListeners | Where-Object { $ports -contains $_.LocalPort }).Count) { throw 'An old app port is still occupied; reinstall was stopped.' }
}

function Get-CfsShortcutAppRoot {
  param($Shortcut)
  $target = [string]$Shortcut.TargetPath
  if ($target -notmatch '^(?:[a-zA-Z]:[\\/]|\\\\)' -or
      [IO.Path]::GetFileName($target) -notin @('LAUNCH_CFS_APP.cmd','LAUNCH_CFS_APP.bat','START_CFS_APP.cmd','START_CFS_APP.bat')) {
    throw 'Shortcut does not directly target a known CFS launcher. Specify -OldAppRoot.'
  }
  $candidate = Split-Path -Parent $target
  if ($Shortcut.WorkingDirectory -and -not (Same-Path $candidate $Shortcut.WorkingDirectory)) {
    throw 'Shortcut target and working directory disagree. Specify -OldAppRoot.'
  }
  return $candidate
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
      Get-ChildItem -LiteralPath $location -Filter "CFS App*.lnk" -File -ErrorAction Stop | ForEach-Object {
        $shortcutPath = $_.FullName
        try {
          $shortcut = $shell.CreateShortcut($shortcutPath)
          $candidate = Get-CfsShortcutAppRoot $shortcut
          if (-not (Test-CfsFolder -Path $candidate)) { throw 'Shortcut installation is unavailable. Specify -OldAppRoot.' }
          if (-not (Same-Path $candidate $appRootFull)) {
            $roots.Add(([System.IO.Path]::GetFullPath($candidate).TrimEnd([System.IO.Path]::DirectorySeparatorChar)))
          }
        } catch {
          Write-Step ("Could not read shortcut {0}: {1}" -f $shortcutPath, $_.Exception.Message)
          throw
        }
      }
    }
  } catch {
    Write-Step ("Could not inspect existing shortcuts: {0}" -f $_.Exception.Message)
    throw
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

try {
$oldRoots = @(Resolve-CfsOldRoots)
if ($oldRoots.Count) {
  Stop-OldCfsRootProcesses -Roots $oldRoots -CheckOnly:$SkipProcessStop
} else {
  Assert-CfsFirstInstallReady
}
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
          throw ("Could not rename {0}; new startup was stopped: {1}" -f $root, $_.Exception.Message)
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
  Start-Process -FilePath (Join-Path $appRootFull "LAUNCH_CFS_APP.cmd") -WorkingDirectory $appRootFull -WindowStyle Hidden
} else {
  Write-Step "Skipped app start by option."
}

Write-Step "CFS clean reinstall helper completed."
} catch {
  Write-Step ('Reinstall refused: ' + $_.Exception.Message)
  throw
}
