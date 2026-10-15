<#
.SYNOPSIS
  Runs the whole verification suite: helper build check, helper self-test, Node unit tests.

.DESCRIPTION
  Order matters: the integration tests drive the published helper, so the helper
  self-test runs first and the Node suite second. Nothing here needs PI-Desktop
  to be running — the in-app check is a separate, opt-in step (see README).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools/run-tests.ps1
#>
[CmdletBinding()]
param(
  [switch]$SkipHelperBuild
)

$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path -Parent $PSScriptRoot
$helper = Join-Path $pluginRoot 'helper\bin\win-x64\pi-conpty-helper.exe'

if (-not $SkipHelperBuild) {
  if (-not (Test-Path $helper)) {
    Write-Host 'helper not built yet; building...'
    & (Join-Path $PSScriptRoot 'build-helper.ps1')
  } else {
    Write-Host "helper present: $helper"
  }
}

if (Test-Path $helper) {
  Write-Host ''
  Write-Host '=== helper self-test (ConPTY plumbing) ==='
  # cmd.exe merges the helper's stderr (its diagnostics) into stdout, so the
  # script never turns a diagnostic line into a PowerShell terminating error.
  & cmd.exe /c "`"$helper`" --selftest 2>&1"
  if ($LASTEXITCODE -ne 0) { throw "helper self-test failed ($LASTEXITCODE)" }
}

Write-Host ''
Write-Host '=== node test suite ==='
Push-Location $pluginRoot
try {
  # Serialized on purpose: the suite starts real shells and binds loopback ports,
  # and running the files in parallel turns timing assertions into flakes.
  # No --test-force-exit: on Windows it exits through process.exit() while a
  # socket is closing and trips a libuv assertion, which would fail a green run.
  & node --test --test-concurrency=1 --test-timeout=120000 'tests/**/*.test.cjs'
  $code = $LASTEXITCODE
} finally {
  Pop-Location
}

if ($code -ne 0) { throw "node --test failed ($code)" }
Write-Host ''
Write-Host 'all checks passed'
