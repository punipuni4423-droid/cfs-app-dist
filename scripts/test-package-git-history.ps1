param([string]$ScratchDirectory = (Join-Path ([IO.Path]::GetTempPath()) ('cfs-package-history-' + [Guid]::NewGuid().ToString('N'))))
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'build-cfs-git-managed-share-package.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Package builder parser errors.' }
foreach ($name in @('Assert-PackageGitObjectsReachable', 'Assert-ArchiveGitMetadata', 'New-ZipArchiveIncludingHidden')) {
  $definition = $ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)[0]
  Invoke-Expression $definition.Extent.Text
}
$source = Join-Path $ScratchDirectory 'source'
$dirtyClone = Join-Path $ScratchDirectory 'physical-clone'
$cleanClone = Join-Path $ScratchDirectory 'transport-clone'
$null = New-Item -ItemType Directory -Force -Path $source
function Invoke-TestGit { param([string[]]$Arguments)
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $output = @(& git @Arguments 2>&1); $code = $LASTEXITCODE } finally { $ErrorActionPreference = $previousPreference }
  if ($code -ne 0) { throw 'Synthetic fixture Git command failed.' }
  return $output
}
$null = Invoke-TestGit @('init', '--initial-branch=master', $source)
Set-Content -LiteralPath (Join-Path $source 'fixture.txt') -Value 'synthetic reachable file'
$null = Invoke-TestGit @('-C', $source, 'add', 'fixture.txt')
$null = Invoke-TestGit @('-C', $source, '-c', 'user.name=CFS Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Synthetic reachable history')
# Write an orphan object without modifying the selected branch.
$orphanFile = Join-Path $ScratchDirectory 'orphan.txt'
Set-Content -LiteralPath $orphanFile -Value 'synthetic unreachable content'
$null = Invoke-TestGit @('-C', $source, 'hash-object', '-w', $orphanFile)
$null = Invoke-TestGit @('clone', '--local', '--no-hardlinks', $source, $dirtyClone)
$rejected = $false
try { $null = Assert-PackageGitObjectsReachable $dirtyClone } catch { $rejected = $true }
if (-not $rejected) { throw 'Physical clone orphan was not rejected.' }
$null = Invoke-TestGit @('clone', '--no-local', '--single-branch', '--no-tags', '--branch', 'master', '--', $source, $cleanClone)
$count = Assert-PackageGitObjectsReachable $cleanClone
if ($count -ne 3) { throw 'Expected commit/tree/blob in the clean clone.' }
$archivePath = Join-Path $ScratchDirectory 'fixture.zip'
New-ZipArchiveIncludingHidden -SourceDirectory $cleanClone -ArchivePath $archivePath
$zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
try { Assert-ArchiveGitMetadata -Archive $zip -Repository $cleanClone } finally { $zip.Dispose() }
$zip = [IO.Compression.ZipFile]::Open($archivePath, [IO.Compression.ZipArchiveMode]::Update)
try { $null = $zip.CreateEntry('.git/objects/unexpected') } finally { $zip.Dispose() }
$zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
$rejected = $false
try { Assert-ArchiveGitMetadata -Archive $zip -Repository $cleanClone } catch { $rejected = $true } finally { $zip.Dispose() }
if (-not $rejected) { throw 'Archive contamination was not rejected.' }
Write-Output "PASS: physical-clone orphan rejected; transport clone reachable-only; ZIP Git bytes match; ZIP contamination rejected. Scratch: $ScratchDirectory"
