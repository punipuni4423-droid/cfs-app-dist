[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$AppRoot)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Startup only: preserve existing assets; never delete a runtime tree.
function Assert-PlainPath([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path)
  $cursor = $full
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Static asset paths must not contain reparse points.'
      }
    }
    $parent = [IO.Path]::GetDirectoryName($cursor)
    if ($parent -eq $cursor) { break }
    $cursor = $parent
  }
  return $full
}

function Get-PlainFiles([string]$Directory) {
  $pending = New-Object 'Collections.Generic.Stack[string]'
  $pending.Push($Directory)
  while ($pending.Count) {
    $current = $pending.Pop()
    foreach ($item in Get-ChildItem -LiteralPath $current -Force) {
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Static asset trees must not contain reparse points.'
      }
      if ($item.PSIsContainer) { $pending.Push($item.FullName) } else { $item }
    }
  }
}

function Get-StreamHash([IO.Stream]$Stream) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $Stream.Position = 0
    return [BitConverter]::ToString($algorithm.ComputeHash($Stream))
  } finally { $algorithm.Dispose(); $Stream.Position = 0 }
}

$heldStreams = New-Object 'Collections.Generic.List[System.IO.FileStream]'
try {
  # Inspect the opened file, not a path that Copy-Item would reopen later.
  if (-not ('CfsStartupStaticFile' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class CfsStartupStaticFile {
  [StructLayout(LayoutKind.Sequential)]
  public struct Info {
    public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh;
    public uint WriteLow, WriteHigh, Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
  public static Info Inspect(FileStream stream) {
    Info info;
    if (!GetFileInformationByHandle(stream.SafeFileHandle, out info))
      throw new Win32Exception(Marshal.GetLastWin32Error());
    if (info.Links == 0 || (info.Attributes & (0x10 | 0x400)) != 0)
      throw new IOException("Static asset file information is invalid.");
    return info;
  }
  public static bool Same(Info left, Info right) {
    return left.Volume == right.Volume && left.IndexHigh == right.IndexHigh && left.IndexLow == right.IndexLow;
  }
}
'@ | Out-Null
  }
  $root = Assert-PlainPath ((Resolve-Path -LiteralPath $AppRoot).Path)
  $source = Assert-PlainPath (Join-Path $root '.next\static')
  $target = Assert-PlainPath (Join-Path $root '.next\standalone\.next\static')
  $boundary = $root.TrimEnd('\') + '\'
  foreach ($directory in @($source, $target)) {
    if (-not $directory.StartsWith($boundary, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Static asset path is outside the app root.'
    }
  }
  $server = Assert-PlainPath (Join-Path $root '.next\standalone\server.js')
  if (-not (Test-Path -LiteralPath $server -PathType Leaf) -or
      -not (Test-Path -LiteralPath $source -PathType Container)) {
    throw 'Standalone build or static assets are missing.'
  }
  $files = @(Get-PlainFiles $source)
  if ($files.Count -eq 0) { throw 'Static asset source is empty.' }
  $existingTargets = @()
  if (Test-Path -LiteralPath $target) {
    if (-not (Test-Path -LiteralPath $target -PathType Container)) { throw 'Static asset target is not a directory.' }
    $existingTargets = @(Get-PlainFiles $target)
  }
  # Keep source and destination handles until verification is complete. All
  # existing destinations must be inspectable before any asset is overwritten.
  $manifest = @($files | ForEach-Object {
    $from = Assert-PlainPath $_.FullName
    $stream = [IO.File]::Open($from, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $heldStreams.Add($stream)
    $info = [CfsStartupStaticFile]::Inspect($stream)
    [pscustomobject]@{ Relative = $_.FullName.Substring($source.Length + 1); Hash = (Get-StreamHash $stream); Stream = $stream; Info = $info }
  })
  $copyTargets = @{}
  foreach ($entry in $manifest) { $copyTargets[(Join-Path $target $entry.Relative)] = $entry }
  $targetStreams = @{}
  foreach ($file in $existingTargets) {
    $to = Assert-PlainPath $file.FullName
    $access = if ($copyTargets.ContainsKey($to)) { [IO.FileAccess]::ReadWrite } else { [IO.FileAccess]::Read }
    $stream = [IO.File]::Open($to, [IO.FileMode]::Open, $access, [IO.FileShare]::None)
    $heldStreams.Add($stream)
    $info = [CfsStartupStaticFile]::Inspect($stream)
    if ($info.Links -ne 1) { throw 'Static asset destinations must have one link.' }
    if ($copyTargets.ContainsKey($to)) {
      if ([CfsStartupStaticFile]::Same($info, $copyTargets[$to].Info)) { throw 'Static asset source and destination must differ.' }
      $targetStreams[$to] = $stream
    }
  }
  $null = New-Item -ItemType Directory -Path $target -Force
  foreach ($entry in $manifest) {
    $to = Assert-PlainPath (Join-Path $target $entry.Relative)
    if (-not $targetStreams.ContainsKey($to)) {
      $null = New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($to)) -Force
      # OpenOrCreate never truncates an existing file before identity/link checks.
      $stream = [IO.File]::Open($to, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
      $heldStreams.Add($stream)
      $info = [CfsStartupStaticFile]::Inspect($stream)
      if ($info.Links -ne 1 -or [CfsStartupStaticFile]::Same($info, $entry.Info)) {
        throw 'Static asset destination identity is unsafe.'
      }
      $targetStreams[$to] = $stream
    }
  }
  foreach ($entry in $manifest) {
    $to = Join-Path $target $entry.Relative
    $stream = $targetStreams[$to]
    if ([CfsStartupStaticFile]::Inspect($stream).Links -ne 1) { throw 'Static asset destination link count changed.' }
    $stream.SetLength(0)
    $entry.Stream.Position = 0
    $entry.Stream.CopyTo($stream)
    $stream.Flush()
    if ((Get-StreamHash $stream) -ne $entry.Hash) {
      throw 'Static asset copy verification failed.'
    }
  }
  Write-Output 'Verified static assets for CFS startup.'
  exit 0
} catch {
  # Keep arbitrary path/exception contents out of launcher status output.
  Write-Output 'CFS static asset synchronization failed. Check the standalone build and folder permissions.'
  exit 1
} finally {
  foreach ($stream in $heldStreams) { $stream.Dispose() }
}
