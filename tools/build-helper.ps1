<#
.SYNOPSIS
  Builds the ConPTY helper and places the single shipped executable inside the plugin.

.DESCRIPTION
  Reproducible build for the one binary this plugin ships:
    helper/bin/win-x64/pi-conpty-helper.exe

  Intermediate and publish output is redirected to %TEMP%, so the plugin
  directory only ever contains the executable itself — a .piplug package holds
  the plugin tree as-is, and stale build output would bloat it past the 50 MB
  package limit.

  Requirements: .NET 8 SDK. The script looks for `dotnet` on PATH, then in
  %USERPROFILE%\.dotnet (the user-local install location).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools/build-helper.ps1
#>
[CmdletBinding()]
param(
  [string]$Configuration = 'Release',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$pluginRoot = Split-Path -Parent $PSScriptRoot
$helperDir = Join-Path $pluginRoot 'helper'
$project = Join-Path $helperDir 'PiConptyHelper.csproj'
$targetDir = Join-Path $helperDir 'bin\win-x64'
$targetExe = Join-Path $targetDir 'pi-conpty-helper.exe'
$workDir = Join-Path ([System.IO.Path]::GetTempPath()) 'pi-windows-terminal-helper'

function Resolve-Dotnet {
  $candidates = @()
  $onPath = Get-Command dotnet -ErrorAction SilentlyContinue
  if ($onPath) { $candidates += $onPath.Source }
  $userLocal = Join-Path $env:USERPROFILE '.dotnet\dotnet.exe'
  $candidates += $userLocal
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }
  throw 'The .NET 8 SDK was not found. Install it (winget install Microsoft.DotNet.SDK.8, or https://dot.net/v1/dotnet-install.ps1 -Channel 8.0) and retry.'
}

if ((Test-Path $targetExe) -and -not $Force) {
  Write-Host "helper already built: $targetExe"
  Write-Host 'pass -Force to rebuild'
  exit 0
}

if (Test-Path $workDir) { Remove-Item $workDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $workDir, $targetDir | Out-Null

$dotnet = Resolve-Dotnet
Write-Host "dotnet      : $dotnet"
& $dotnet --version

$publishDir = Join-Path $workDir 'publish'
Write-Host 'publishing self-contained win-x64 single file...'
& $dotnet publish $project `
  -c $Configuration `
  -r win-x64 `
  --self-contained true `
  -p:PublishSingleFile=true `
  -p:PublishTrimmed=true `
  -p:IncludeNativeLibrariesForSelfExtract=true `
  -p:EnableCompressionInSingleFile=true `
  -p:BaseIntermediateOutputPath="$workDir\obj\" `
  -p:BaseOutputPath="$workDir\bin\" `
  -o $publishDir

if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed with exit code $LASTEXITCODE" }

$produced = Join-Path $publishDir 'pi-conpty-helper.exe'
if (-not (Test-Path $produced)) { throw "expected $produced was not produced" }

Copy-Item $produced $targetExe -Force
$size = (Get-Item $targetExe).Length
$hash = (Get-FileHash $targetExe -Algorithm SHA256).Hash
Write-Host ("helper      : {0} ({1:N2} MiB)" -f $targetExe, ($size / 1MB))
Write-Host "sha256      : $hash"

Write-Host 'self-test...'
# The helper writes diagnostics to stderr on purpose, and this script runs with
# $ErrorActionPreference = 'Stop': without the temporary switch, PowerShell turns
# that normal stderr output into a terminating error and the build "fails" on a
# healthy self-test.
$selfTestPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  & $targetExe --selftest 2>&1 | ForEach-Object { Write-Host $_ }
  $selfTestCode = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $selfTestPreference
}
if ($selfTestCode -ne 0) { throw "the helper self-test failed with exit code $selfTestCode" }
Write-Host 'build ok'
