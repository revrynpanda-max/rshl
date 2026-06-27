# run-ecosystem.ps1
# Default: foreground node - live bot + watchdog output in this console (Start-KAI).
# -Detached / KAI_ECOSYSTEM_DETACHED=1: hidden manager survives short-lived parents (harness).

param(
    [switch]$Detached
)

$ErrorActionPreference = 'Continue'
$OracleRoot = $PSScriptRoot
$StatePath = Join-Path $OracleRoot 'state\ecosystem-manager.json'
$useDetached = $Detached -or ($env:KAI_ECOSYSTEM_DETACHED -eq '1')

if (-not $useDetached) {
    Write-Host 'Starting Oracle Ecosystem Manager - live fleet output below.' -ForegroundColor Cyan
    Write-Host '(Ctrl+C stops the fleet. Second window: .\tools\oracle-discord\watch-logs.ps1 -Essentials)' -ForegroundColor DarkGray
    Write-Host ''
    Push-Location $OracleRoot
    try {
        & node ecosystem-manager.mjs
        $code = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }
    } finally {
        Pop-Location
    }
    if ($code -ne 0) {
        Write-Host ''
        Write-Host "Ecosystem Manager exited (code $code)." -ForegroundColor Red
        exit $code
    }
    exit 0
}

Write-Host 'Starting Oracle Ecosystem Manager (detached)...' -ForegroundColor Cyan

$mgrProc = Start-Process -FilePath 'node' `
    -ArgumentList @('ecosystem-manager.mjs') `
    -WorkingDirectory $OracleRoot `
    -WindowStyle Hidden `
    -PassThru

if (-not $mgrProc) {
    Write-Host 'Failed to spawn ecosystem-manager.mjs' -ForegroundColor Red
    exit 1
}

Write-Host "Ecosystem Manager spawned (PID $($mgrProc.Id)). Monitoring..." -ForegroundColor Green
Write-Host 'Tail logs: .\tools\oracle-discord\watch-logs.ps1 -Essentials' -ForegroundColor DarkGray

$stateReady = $false
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
    if (Test-Path $StatePath) {
        try {
            $st = Get-Content $StatePath -Raw | ConvertFrom-Json
            if ($st.managerPid -eq $mgrProc.Id) { $stateReady = $true; break }
        } catch {}
    }
    if ($mgrProc.HasExited) { break }
    Start-Sleep -Milliseconds 500
}

if ($mgrProc.HasExited) {
    $ec = if ($mgrProc.ExitCode) { $mgrProc.ExitCode } else { 1 }
    Write-Host "Ecosystem Manager exited during startup (code $ec)." -ForegroundColor Red
    exit $ec
}

if (-not $stateReady) {
    Write-Host "Warning: manager state not confirmed for PID $($mgrProc.Id); continuing monitor." -ForegroundColor DarkYellow
}

while (-not $mgrProc.HasExited) {
    Start-Sleep -Seconds 10
}

$code = $mgrProc.ExitCode
Write-Host ''
Write-Host "Ecosystem Manager exited (code $code)." -ForegroundColor Red
if ($code -and $code -ne 0) { exit $code }
exit 0