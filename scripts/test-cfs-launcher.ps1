param([string]$ScratchDirectory = (Join-Path ([IO.Path]::GetTempPath()) ('cfs-launcher-test-' + [Guid]::NewGuid().ToString('N'))))
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$sourceRoot = Split-Path -Parent $PSScriptRoot
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'launch-cfs-app.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Launcher parser errors.' }
foreach ($name in @('Resolve-CfsLauncherNode', 'Open-CfsBrowser')) {
  $definition = $ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)[0]
  Invoke-Expression $definition.Extent.Text
}
$appRoot = $sourceRoot
$realNode = Resolve-CfsLauncherNode
$appRoot = Join-Path $ScratchDirectory "CFS test's folder"
$nodeHome = Join-Path $appRoot '.cfs-runtime\node-test'
$null = New-Item -ItemType Directory -Force -Path $nodeHome, (Join-Path $appRoot 'scripts')
Copy-Item -LiteralPath $realNode -Destination (Join-Path $nodeHome 'node.exe')
$accessScript = Join-Path $appRoot 'scripts\cfs-access.mjs'
Set-Content -LiteralPath $accessScript -Encoding UTF8 -Value "process.stdout.write(process.argv[2] + '#cfs_access=test-only');"
function Get-CfsBrowserExecutable { return 'test-browser.exe' }
function Start-Process { param($FilePath, $ArgumentList, $WorkingDirectory) $script:opened = @($ArgumentList); return $null }
$savedPath = $env:PATH
$savedAuthRoot = $env:CFS_APP_DIR
$passes = 0
try {
  $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
  $env:CFS_APP_DIR = 'parent-sentinel'
  $resolved = Resolve-CfsLauncherNode
  if ($resolved -ne (Join-Path $nodeHome 'node.exe')) { throw 'Bundled Node not selected.' }
  $passes++
  $script:opened = @()
  Open-CfsBrowser -Url 'http://localhost:3999/'
  if ($script:opened[0] -ne '--app=http://localhost:3999/#cfs_access=test-only') { throw 'Grant URL was not passed to browser.' }
  if ($env:CFS_APP_DIR -ne 'parent-sentinel') { throw 'Auth environment not restored.' }
  $passes++
  Set-Content -LiteralPath $accessScript -Encoding UTF8 -Value "process.stderr.write('private-test-grant'); process.exit(1);"
  $script:opened = @()
  $failed = $false
  try { Open-CfsBrowser -Url 'http://localhost:3999/' } catch { $failed = $true }
  if (-not $failed -or $script:opened.Count -ne 0 -or $env:CFS_APP_DIR -ne 'parent-sentinel') { throw 'Auth CLI failure was not contained.' }
  $passes++
  $appRoot = Join-Path $ScratchDirectory 'missing-runtime'
  $failed = $false
  try { $null = Resolve-CfsLauncherNode } catch { $failed = $true }
  if (-not $failed) { throw 'Missing Node did not fail.' }
  $passes++
  $env:PATH = (Split-Path -Parent $realNode) + ';' + $env:PATH
  if ((Resolve-CfsLauncherNode) -ne $realNode) { throw 'PATH Node fallback failed.' }
  $passes++
} finally {
  $env:PATH = $savedPath
  if ($null -eq $savedAuthRoot) { Remove-Item Env:CFS_APP_DIR -ErrorAction SilentlyContinue } else { $env:CFS_APP_DIR = $savedAuthRoot }
}
Write-Output ("PASS: $passes launcher checks; synthetic fixture only. Scratch: $ScratchDirectory")
