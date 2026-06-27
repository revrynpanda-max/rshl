# Preflight: full git porcelain must only touch fleet-allowlisted paths.
# Exit 0 = clean scope. Exit 1 = violations printed.
param([switch]$Quiet)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot\..
$Root = (Get-Location).Path

function Test-FleetPathAllowed([string]$rel) {
    $r = $rel -replace '\\', '/'
    if ($r -eq 'Cargo.toml') { return $true }
    if ($r -eq 'The KAI Codex.md') { return $true }
    if ($r -eq 'Start-KAI.ps1') { return $true }
    if ($r -eq 'run-oracle-discord.ps1') { return $true }
    if ($r -eq 'KAI-Start.bat') { return $true }
    if ($r -eq 'KAI-Stop.bat') { return $true }
    if ($r -eq 'state/phoenix_auto_heal.flag') { return $true }
    if ($r -eq 'tools/assert-fleet-scope.ps1') { return $true }
    if ($r -eq 'tools/capture-fleet-boot.ps1') { return $true }
    if ($r -eq 'tools/fleet-soak-evidence.ps1') { return $true }
    if ($r -eq 'tools/post-boot-error-audit.ps1') { return $true }
    if ($r -eq 'tools/verify-fleet-pipeline.ps1') { return $true }
    if ($r -eq 'tools/fleet-response-probe.ps1') { return $true }
    if ($r -eq 'tools/fleet-build-stamp-audit.ps1') { return $true }
    if ($r -eq 'tools/leo-voice-response-probe.ps1') { return $true }
    if ($r -eq 'tools/fleet-text-response-probe.ps1') { return $true }
    if ($r -like 'tools/oracle-discord/*') { return $true }
    return $false
}

$lines = @(git status --porcelain 2>&1)
$violations = @()
foreach ($line in $lines) {
    if (-not $line -or $line.Length -lt 4) { continue }
    $path = $line.Substring(3).Trim().Trim('"')
    if ($path -match ' -> ') { $path = ($path -split ' -> ')[0].Trim().Trim('"') }
    # Runtime/session artifacts — not fleet code changes
    if ($path -like 'terminals/*' -or $path -eq 'terminals/') { continue }
    if ($path -like 'scratch/*' -or $path -eq 'scratch/') { continue }
    if ($path -eq 'data/overnight_ingest.lock') { continue }
    if (-not (Test-FleetPathAllowed $path)) {
        $violations += $line
    }
}

if ($violations.Count -gt 0) {
    if (-not $Quiet) {
        Write-Host '[assert-fleet-scope] FAIL - paths outside fleet allowlist:' -ForegroundColor Red
        $violations | ForEach-Object { Write-Host "  $_" }
        Write-Host 'Allowlist: tools/oracle-discord/**, Start-KAI.ps1, KAI-Start.bat, KAI-Stop.bat, run-oracle-discord.ps1, Cargo.toml, The KAI Codex.md, state/phoenix_auto_heal.flag' -ForegroundColor DarkYellow
    }
    exit 1
}

if (-not $Quiet) { Write-Host '[assert-fleet-scope] PASS - workspace scope clean.' -ForegroundColor Green }
exit 0