param(
  [string]$ProjectRef = "",
  [switch]$Login,
  [switch]$Link,
  [switch]$PushMigration,
  [switch]$Check,
  [switch]$SeedCurrentProjects,
  [switch]$AllowLegacyServiceRole,
  [string]$AppUrl = "http://localhost:3014"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$EnvPath = Join-Path $Root ".env.local"
$TableFallback = "cfs_projects"

function Read-CfsEnvFile {
  param([string]$Path)
  $values = @{}
  if (!(Test-Path -LiteralPath $Path)) {
    return $values
  }
  foreach ($line in Get-Content -LiteralPath $Path) {
    $trimmed = $line.Trim()
    if ($trimmed -eq "" -or $trimmed.StartsWith("#")) { continue }
    $parts = $trimmed -split "=", 2
    if ($parts.Count -ne 2) { continue }
    $key = $parts[0].Trim()
    $value = $parts[1].Trim().Trim('"').Trim("'")
    if ($key) { $values[$key] = $value }
  }
  return $values
}

function Invoke-SupabaseCli {
  param([string[]]$Args)
  Push-Location $Root
  try {
    & npx.cmd supabase @Args
    if ($LASTEXITCODE -ne 0) {
      throw "supabase CLI failed: supabase $($Args -join ' ')"
    }
  } finally {
    Pop-Location
  }
}

function Get-EnvValue {
  param(
    [hashtable]$Values,
    [string]$Name
  )
  if ($Values.ContainsKey($Name) -and $Values[$Name]) { return $Values[$Name] }
  $envValue = [Environment]::GetEnvironmentVariable($Name)
  if ($envValue) { return $envValue }
  return ""
}

function Get-CurrentProjectsPayload {
  param([string]$Url)
  try {
    return Invoke-RestMethod -Uri "$Url/api/projects" -TimeoutSec 10
  } catch {
    $dataFile = Join-Path $Root "data\projects.json"
    if (!(Test-Path -LiteralPath $dataFile)) { throw }
    $projects = Get-Content -LiteralPath $dataFile -Raw | ConvertFrom-Json
    return [pscustomobject]@{ projects = @($projects) }
  }
}

$envValues = Read-CfsEnvFile -Path $EnvPath
$supabaseUrl = (Get-EnvValue -Values $envValues -Name "SUPABASE_URL").TrimEnd("/")
$serviceRoleKey = Get-EnvValue -Values $envValues -Name "SUPABASE_SERVICE_ROLE_KEY"
$tableName = Get-EnvValue -Values $envValues -Name "SUPABASE_PROJECTS_TABLE"
if (!$tableName) { $tableName = $TableFallback }

if ($Login) {
  Invoke-SupabaseCli -Args @("login")
}

if ($Link) {
  if (!$ProjectRef) {
    throw "ProjectRef is required when using -Link."
  }
  Invoke-SupabaseCli -Args @("link", "--project-ref", $ProjectRef)
}

if ($PushMigration) {
  Invoke-SupabaseCli -Args @("db", "push")
}

if ($Check -or $SeedCurrentProjects) {
  if (!$AllowLegacyServiceRole) {
    throw "Legacy Service Role REST setup is disabled. Use the secure Supabase sharing Function flow, or rerun with -AllowLegacyServiceRole only for a disposable legacy migration after reviewing the risk."
  }
  if (!$supabaseUrl -or !$serviceRoleKey) {
    throw "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local before checking or seeding Supabase."
  }
  if ($tableName -notmatch "^[a-zA-Z_][a-zA-Z0-9_]*$") {
    throw "Invalid SUPABASE_PROJECTS_TABLE value: $tableName"
  }

  $headers = @{
    apikey = $serviceRoleKey
    Authorization = "Bearer $serviceRoleKey"
  }

  $checkUrl = "${supabaseUrl}/rest/v1/${tableName}?select=id&limit=1"
  Invoke-RestMethod -Uri $checkUrl -Headers $headers -TimeoutSec 20 | Out-Null
  Write-Host "Supabase table check passed: $tableName"
}

if ($SeedCurrentProjects) {
  $payload = Get-CurrentProjectsPayload -Url $AppUrl
  $projects = @($payload.projects)
  if ($projects.Count -eq 0) {
    Write-Host "No projects to seed."
    exit 0
  }

  $rows = $projects | ForEach-Object {
    [pscustomobject]@{
      id = $_.id
      name = $_.name
      updated_at = $_.updatedAt
      payload = $_
    }
  }

  $headers = @{
    apikey = $serviceRoleKey
    Authorization = "Bearer $serviceRoleKey"
    "Content-Type" = "application/json"
    Prefer = "resolution=merge-duplicates,return=minimal"
  }
  $seedUrl = "$supabaseUrl/rest/v1/$tableName" + "?on_conflict=id"
  Invoke-RestMethod -Method Post -Uri $seedUrl -Headers $headers -Body ($rows | ConvertTo-Json -Depth 100) -TimeoutSec 60 | Out-Null
  Write-Host "Seeded $($projects.Count) project(s) to Supabase table: $tableName"
}

Write-Host "CFS Supabase setup command finished."
