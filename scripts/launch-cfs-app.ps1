param(
  [int]$Port = 3014,
  [ValidateSet("Auto", "Edge", "Chrome")]
  [string]$PreferredBrowser = "Auto",
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($env:CFS_OPEN_BROWSER -eq "0") {
  $NoBrowser = $true
}

$appRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$startScript = Join-Path $appRoot "START_CFS_APP.bat"
$startupDir = Join-Path $appRoot "artifacts\startup"
$statusFile = Join-Path $startupDir "latest-status.txt"
$iconPath = Join-Path $appRoot "public\cfs-app-icon.ico"
$script:exitCode = 0
$script:worker = $null

function Initialize-StartupFolder {
  if (-not (Test-Path -LiteralPath $startupDir)) {
    New-Item -ItemType Directory -Force -Path $startupDir | Out-Null
  }
}

function Write-LauncherStatus {
  param([string]$Message)
  Initialize-StartupFolder
  $timestamp = Get-Date -Format "yyyy/MM/dd HH:mm:ss"
  Set-Content -LiteralPath $statusFile -Value "[$timestamp] $Message" -Encoding UTF8
}

function Read-LauncherStatus {
  if (-not (Test-Path -LiteralPath $statusFile)) {
    return "Preparing CFS startup."
  }
  try {
    $content = Get-Content -LiteralPath $statusFile -Tail 1 -ErrorAction Stop
    if ([string]::IsNullOrWhiteSpace($content)) {
      return "Preparing CFS startup."
    }
    return ($content -replace '^\[[^\]]+\]\s*', '')
  } catch {
    return "Preparing CFS startup."
  }
}

function Get-ProgressFromStatus {
  param([string]$Status)
  if ($Status -match "ready") { return 100 }
  if ($Status -match "Starting CFS") { return 82 }
  if ($Status -match "Building") { return 66 }
  if ($Status -match "Installing") { return 42 }
  if ($Status -match "Node") { return 28 }
  if ($Status -match "Preparing") { return 15 }
  if ($Status -match "failed|not usable|already in use|did not become ready") { return 100 }
  return 20
}

function Get-CfsBrowserExecutable {
  $edgePaths = @(
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
  )
  $chromePaths = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
  $ordered = switch ($PreferredBrowser) {
    "Edge" { $edgePaths + $chromePaths }
    "Chrome" { $chromePaths + $edgePaths }
    default { $chromePaths + $edgePaths }
  }
  foreach ($candidate in $ordered) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return $candidate
    }
  }
  return $null
}

function Get-ReadyUrlFromStatus {
  param([string]$Status)
  if ($Status -match "http://localhost:(\d+)") {
    return "http://localhost:$($Matches[1])/"
  }
  return "http://localhost:$Port/"
}

function Open-CfsBrowser {
  param([string]$Url)
  $browserPath = Get-CfsBrowserExecutable
  if ($browserPath) {
    $arguments = @(
      "--app=$Url",
      "--new-window",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-session-crashed-bubble"
    )
    Start-Process -FilePath $browserPath -ArgumentList $arguments -WorkingDirectory $appRoot | Out-Null
    return
  }
  Start-Process $Url | Out-Null
}

function Start-CfsWorker {
  if (-not (Test-Path -LiteralPath $startScript)) {
    throw "START_CFS_APP.bat was not found."
  }
  $processInfo = New-Object System.Diagnostics.ProcessStartInfo
  $processInfo.FileName = Join-Path $env:SystemRoot "System32\cmd.exe"
  # cmd /s strips the first and last quote of the /c string, so the whole
  # command must be wrapped in an extra pair of quotes (same pattern as
  # LAUNCH_CFS_APP.vbs) or a start script path containing spaces gets split.
  $processInfo.Arguments = '/d /s /c ""' + $startScript + '" --worker --no-browser"'
  $processInfo.WorkingDirectory = $appRoot
  $processInfo.UseShellExecute = $false
  $processInfo.CreateNoWindow = $true
  $processInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $processInfo.EnvironmentVariables["PORT"] = [string]$Port
  $processInfo.EnvironmentVariables["CFS_ALLOW_PORT_FALLBACK"] = "1"
  $processInfo.EnvironmentVariables["CFS_OPEN_BROWSER"] = "0"
  return [System.Diagnostics.Process]::Start($processInfo)
}

Initialize-StartupFolder
Write-LauncherStatus "Preparing CFS startup."

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = "CFS App"
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.ShowInTaskbar = $true
$form.TopMost = $true
$form.ClientSize = New-Object System.Drawing.Size(430, 156)
if (Test-Path -LiteralPath $iconPath) {
  try {
    $form.Icon = New-Object System.Drawing.Icon($iconPath)
  } catch {
    # The launcher remains usable even if the icon file is unavailable or invalid.
  }
}

$titleLabel = New-Object System.Windows.Forms.Label
$titleLabel.Text = "Starting CFS App"
$titleLabel.AutoSize = $true
$titleLabel.Font = New-Object System.Drawing.Font("Segoe UI", 14, [System.Drawing.FontStyle]::Bold)
$titleLabel.Location = New-Object System.Drawing.Point(24, 22)

$detailLabel = New-Object System.Windows.Forms.Label
$detailLabel.Text = "Preparing CFS startup."
$detailLabel.AutoEllipsis = $true
$detailLabel.Size = New-Object System.Drawing.Size(378, 24)
$detailLabel.Location = New-Object System.Drawing.Point(25, 62)
$detailLabel.Font = New-Object System.Drawing.Font("Segoe UI", 9)

$progressBar = New-Object System.Windows.Forms.ProgressBar
$progressBar.Minimum = 0
$progressBar.Maximum = 100
$progressBar.Value = 10
$progressBar.Style = "Continuous"
$progressBar.Size = New-Object System.Drawing.Size(344, 12)
$progressBar.Location = New-Object System.Drawing.Point(28, 104)

$percentLabel = New-Object System.Windows.Forms.Label
$percentLabel.Text = "10%"
$percentLabel.AutoSize = $false
$percentLabel.TextAlign = "MiddleRight"
$percentLabel.Size = New-Object System.Drawing.Size(48, 18)
$percentLabel.Location = New-Object System.Drawing.Point(360, 98)
$percentLabel.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)

$hintLabel = New-Object System.Windows.Forms.Label
$hintLabel.Text = "This window closes automatically when CFS is ready."
$hintLabel.AutoSize = $true
$hintLabel.Font = New-Object System.Drawing.Font("Segoe UI", 8)
$hintLabel.ForeColor = [System.Drawing.Color]::FromArgb(95, 107, 122)
$hintLabel.Location = New-Object System.Drawing.Point(26, 128)

$form.Controls.AddRange(@($titleLabel, $detailLabel, $progressBar, $percentLabel, $hintLabel))

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 500
$timer.Add_Tick({
  $status = Read-LauncherStatus
  $progress = [Math]::Min([Math]::Max((Get-ProgressFromStatus $status), 0), 100)
  $detailLabel.Text = $status
  $progressBar.Value = $progress
  $percentLabel.Text = "$progress%"

  if ($script:worker -and $script:worker.HasExited) {
    $timer.Stop()
    $script:exitCode = $script:worker.ExitCode
    if ($script:exitCode -eq 0) {
      $readyUrl = Get-ReadyUrlFromStatus (Read-LauncherStatus)
      $detailLabel.Text = "CFS is ready at $readyUrl"
      $progressBar.Value = 100
      $percentLabel.Text = "100%"
      [System.Windows.Forms.Application]::DoEvents()
      if (-not $NoBrowser) {
        Open-CfsBrowser -Url $readyUrl
      }
      Start-Sleep -Milliseconds 350
      $form.Close()
      return
    }

    $detail = Read-LauncherStatus
    [System.Windows.Forms.MessageBox]::Show(
      "CFS could not be started.`r`n`r`n$detail`r`n`r`nCheck artifacts\startup\latest-status.txt and the newest start/server logs.",
      "CFS App",
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
    $form.Close()
  }
})

$form.Add_Shown({
  try {
    $script:worker = Start-CfsWorker
    $timer.Start()
  } catch {
    $script:exitCode = 1
    [System.Windows.Forms.MessageBox]::Show(
      $_.Exception.Message,
      "CFS App",
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
    $form.Close()
  }
})

[System.Windows.Forms.Application]::EnableVisualStyles()
[System.Windows.Forms.Application]::Run($form)
exit $script:exitCode
