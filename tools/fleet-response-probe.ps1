# GATE 7: IPC /health probes — proves running bots respond with correct identity.
param(
    [string]$Out = $env:FLEET_RESPONSE_PROBE_OUT,
    [int]$MaxUptimeMs = 0,
    [string]$ScratchDir = $env:FLEET_BOOT_SCRATCH
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not $ScratchDir) {
    $ScratchDir = 'C:\Users\revry\AppData\Local\Temp\grok-goal-d07e950bed3b\implementer'
}
if (-not $Out) {
    $Out = Join-Path $ScratchDir 'fleet-response-probe.txt'
}
New-Item -ItemType Directory -Force -Path (Split-Path $Out -Parent) | Out-Null

$targets = @(
    @{ name = 'Leo'; port = 3400 },
    @{ name = 'KAI'; port = 3401 },
    @{ name = 'Groq'; port = 3405 },
    @{ name = 'Analyst'; port = 3406 },
    @{ name = 'Researcher'; port = 3407 },
    @{ name = 'Kai Coder'; port = 3408 }
)

$lines = @(
    "=== FLEET RESPONSE PROBE $(Get-Date -Format o) ===",
    "max_uptime_ms=$MaxUptimeMs",
    ""
)

function Invoke-BotHealthProbe([int]$port, [string]$expectName, [int]$maxUptimeMs) {
    foreach ($attempt in 1..8) {
        try {
            $resp = Invoke-WebRequest -Uri ("http://127.0.0.1:$port/health") -UseBasicParsing -TimeoutSec 5
            $json = $resp.Content | ConvertFrom-Json
            $nameOk = ($json.name -eq $expectName)
            $uptime = [int]$json.uptime_ms
            $uptimeOk = ($maxUptimeMs -le 0) -or ($uptime -lt ($maxUptimeMs + 600000))
            return @{
                ok = ($nameOk -and $uptimeOk)
                detail = "name=$($json.name) pid=$($json.pid) uptime_ms=$uptime name_ok=$nameOk uptime_ok=$uptimeOk attempt=$attempt"
            }
        } catch {
            if ($attempt -lt 8) { Start-Sleep -Seconds 3; continue }
            return @{ ok = $false; detail = "ERROR after $attempt attempts: $($_.Exception.Message)" }
        }
    }
    return @{ ok = $false; detail = 'ERROR: probe exhausted retries' }
}

$allOk = $true
foreach ($t in $targets) {
    $row = Invoke-BotHealthProbe -port $t.port -expectName $t.name -maxUptimeMs $MaxUptimeMs
    if (-not $row.ok) { $allOk = $false }
    $lines += ("$($t.name):$($t.port) ok=$($row.ok) $($row.detail)")
}

$lines += ""
$lines += "probe_pass=$allOk"
$lines | Out-File $Out -Encoding utf8
Get-Content $Out
exit $(if ($allOk) { 0 } else { 1 })