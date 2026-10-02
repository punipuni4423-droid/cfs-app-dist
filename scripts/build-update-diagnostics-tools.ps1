param([Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression
$root=Split-Path $PSScriptRoot -Parent
$toolsOutputPath=$OutputPath
. (Join-Path $PSScriptRoot 'cfs-update-diagnostics.ps1')
$target=Assert-CfsDiagnosticPath $toolsOutputPath
$files=@{'COLLECT_CFS_UPDATE_DIAGNOSTICS.cmd'='COLLECT_CFS_UPDATE_DIAGNOSTICS.cmd';'scripts/cfs-update-diagnostics.ps1'='scripts/cfs-update-diagnostics.ps1';'README_JA.md'='docs/UPDATE_DIAGNOSTICS_TOOLS_JA.md'}
$stream=[IO.File]::Open($target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try{$zip=New-Object IO.Compression.ZipArchive($stream,[IO.Compression.ZipArchiveMode]::Create,$true);try{foreach($name in $files.Keys){$bytes=[IO.File]::ReadAllBytes((Join-Path $root $files[$name]));$entry=$zip.CreateEntry($name);$writer=$entry.Open();try{$writer.Write($bytes,0,$bytes.Length)}finally{$writer.Dispose()}}}finally{$zip.Dispose()}}finally{$stream.Dispose()}
Write-Host 'Standalone diagnostics tools ZIP created.'
