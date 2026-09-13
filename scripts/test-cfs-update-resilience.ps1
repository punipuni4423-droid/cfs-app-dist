param([Parameter(Mandatory=$true)][string]$EvidenceRoot)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$null=New-Item -ItemType Directory -Force -Path $EvidenceRoot
$fixture=Join-Path $EvidenceRoot ('guards-'+[Guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $fixture
. (Join-Path $PSScriptRoot 'cfs-update-maintenance.ps1')
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'update-cfs-app.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Worker parse failed'}
foreach($name in @('Get-NextDistPath','Assert-CfsNoLegacyData','Clear-NextBuildOutput','Test-CfsVerifiedBuild','Start-CfsAppServer')){
  $f=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
  Invoke-Expression $f.Extent.Text
}
function Write-Log([string]$Message){}
function Import-PublicSupabaseEnv{}
$env:NEXT_DIST_DIR=$null
$cases=@()
foreach($relative in @('.next\standalone\data','runtime\data')){
  $root=Join-Path $fixture ([Guid]::NewGuid().ToString('N'))
  $store=Join-Path $root $relative
  $null=New-Item -ItemType Directory -Force -Path $store
  $marker=Join-Path $store 'original.json'
  [IO.File]::WriteAllText($marker,'{"original":"preserve"}')
  $hash=(Get-FileHash -LiteralPath $marker).Hash
  $refused=$false
  try{Clear-NextBuildOutput $root}catch{if($_.Exception.Message -match 'Legacy or multiple'){$refused=$true}else{throw}}
  if(-not $refused -or (Get-FileHash -LiteralPath $marker).Hash -ne $hash){throw 'Legacy store was not preserved'}
  $cases+=@{name=$relative;refused=$true;bytesPreserved=$true}
}
$cleanRoot=Join-Path $fixture 'clean'
$null=New-Item -ItemType Directory -Force -Path (Join-Path $cleanRoot '.next\standalone\data')
Assert-CfsNoLegacyData $cleanRoot
$lock=Enter-CfsUpdateMaintenance $cleanRoot
try {
  Assert-CfsUpdateMaintenanceHandle $cleanRoot $lock
  $refused=$false
  try{$other=Enter-CfsUpdateMaintenance $cleanRoot;$other.Dispose()}catch [IO.IOException]{$refused=$true}
  if(-not $refused){throw 'Concurrent lock acquired'}
}finally{$lock.Dispose()}
if(Test-CfsUpdateMaintenanceActive $cleanRoot){throw 'Lock was not released'}
$cases+=@{name='FileStream';exclusive=$true;released=$true}
$appPath=$cleanRoot;$TargetCommit=('a'*40);$script:BuildStartedAt=$null
$null=New-Item -ItemType Directory -Force -Path (Join-Path $cleanRoot 'runtime')
[IO.File]::WriteAllText((Join-Path $cleanRoot 'runtime\server.js'),"throw 'old runtime must not start'")
$refused=$false
try{Start-CfsAppServer}catch{if($_.Exception.Message -match 'No verified updated build'){$refused=$true}else{throw}}
if(-not $refused){throw 'Old runtime accepted'}
$cases+=@{name='old-runtime';automaticStartRefused=$true}
foreach($output in @('.git','.git\objects')){
  $repoFixture=Join-Path $fixture ('git-protected-'+[Guid]::NewGuid().ToString('N'))
  $null=New-Item -ItemType Directory -Force -Path (Join-Path $repoFixture '.git\objects')
  $gitMarker=Join-Path $repoFixture '.git\HEAD'
  [IO.File]::WriteAllText($gitMarker,'synthetic Git metadata original')
  $beforeHash=(Get-FileHash -LiteralPath $gitMarker).Hash
  $oldDist=$env:NEXT_DIST_DIR
  try {
    $env:NEXT_DIST_DIR=$output;$refused=$false
    try{Clear-NextBuildOutput $repoFixture}catch{if($_.Exception.Message -match 'Refusing'){$refused=$true}else{throw}}
    if(-not $refused -or (Get-FileHash -LiteralPath $gitMarker).Hash -ne $beforeHash){throw 'Git metadata was not protected'}
  }finally{$env:NEXT_DIST_DIR=$oldDist}
  $cases+=@{name=$output;refused=$true;metadataPreserved=$true}
}
@{pass=$true;fixture=$fixture;cases=$cases}|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $EvidenceRoot 'resilience-guards.json') -Encoding UTF8
'PASS: legacy data preservation, shared lock, unverified runtime refusal.'
