param(
    [switch]$Foreground,
    [int]$HealthWaitSec = 45
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$stateDir = Join-Path $root "state"
$logDir = Join-Path $root "logs"
$scratchDir = "C:\KAI\scratch"
New-Item -ItemType Directory -Force -Path $stateDir, $logDir, $scratchDir | Out-Null

$managerState = Join-Path $stateDir "ecosystem-manager.json"
$managerOut = Join-Path $scratchDir "ecosystem-manager.out.log"
$managerErr = Join-Path $scratchDir "ecosystem-manager.err.log"

function Test-HttpOk {
    param([int]$Port, [string]$Path = "/health", [int]$TimeoutSec = 2)
    try {
        $res = Invoke-WebRequest -Uri "http://127.0.0.1:$Port$Path" -UseBasicParsing -TimeoutSec $TimeoutSec
        return ($res.StatusCode -ge 200 -and $res.StatusCode -lt 300)
    } catch {
        return $false
    }
}

function Wait-EcosystemHealth {
    param([int]$Seconds)
    $sleepList = @()
    if ($env:ORACLE_START_SLEEP_BOTS) {
        $sleepList = $env:ORACLE_START_SLEEP_BOTS.Split(",") | ForEach-Object { $_.Trim().ToLowerInvariant() }
    }
    $critical = @(
        @{ Name = "Dashboard"; Port = 3001; Path = "/health" },
        @{ Name = "Oracle";    Port = 3410; Path = "/health" },
        @{ Name = "KAI";       Port = 3401; Path = "/health" },
        @{ Name = "Leo";       Port = 3400; Path = "/health" }
    ) | Where-Object { $sleepList -notcontains $_.Name.ToLowerInvariant() }
    $deadline = (Get-Date).AddSeconds($Seconds)
    $last = @{}
    do {
        $all = $true
        foreach ($target in $critical) {
            $ok = Test-HttpOk -Port $target.Port -Path $target.Path
            $last[$target.Name] = $ok
            if (-not $ok) { $all = $false }
        }
        if ($all) { return @{ ok = $true; last = $last } }
        Start-Sleep -Milliseconds 1000
    } while ((Get-Date) -lt $deadline)
    return @{ ok = $false; last = $last }
}

Write-Host "Starting Oracle Ecosystem Manager..." -ForegroundColor Cyan

if ($Foreground) {
    node ecosystem-manager.mjs
    Write-Host "`nEcosystem Manager exited." -ForegroundColor Red
    exit $LASTEXITCODE
}

$existing = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^node(\.exe)?$' -and $_.CommandLine -match 'ecosystem-manager\.mjs' }
if ($existing) {
    Write-Host "Existing ecosystem manager already running: PID(s) $($existing.ProcessId -join ', ')"
} else {
    # FIX: redirect stdin from an empty file so the manager runs truly headless.
    # Without this it inherited the launcher's console TTY (readline CLI active),
    # and died with EPIPE whenever this terminal closed.
    $managerIn = Join-Path $scratchDir "ecosystem-manager.stdin"
    if (-not (Test-Path $managerIn)) { New-Item -ItemType File -Path $managerIn -Force | Out-Null }
    $proc = Start-Process -FilePath "node" `
        -ArgumentList "ecosystem-manager.mjs" `
        -WorkingDirectory $root `
        -WindowStyle Hidden `
        -RedirectStandardInput $managerIn `
        -RedirectStandardOutput $managerOut `
        -RedirectStandardError $managerErr `
        -PassThru
    Write-Host "Ecosystem manager launched detached. PID: $($proc.Id)"
}

Write-Host "Waiting up to $HealthWaitSec seconds for critical health endpoints..."
$health = Wait-EcosystemHealth -Seconds $HealthWaitSec
if ($health.ok) {
    Write-Host "Critical ecosystem endpoints are online." -ForegroundColor Green
} else {
    Write-Host "Some critical endpoints did not come online yet:" -ForegroundColor Yellow
    $health.last.GetEnumerator() | Sort-Object Name | ForEach-Object {
        Write-Host ("  {0}: {1}" -f $_.Key, $(if ($_.Value) { "OK" } else { "DOWN" }))
    }
    Write-Host "Manager stdout: $managerOut"
    Write-Host "Manager stderr: $managerErr"
    if (Test-Path $managerState) { Write-Host "Manager state: $managerState" }
}
