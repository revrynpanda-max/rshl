# TEXT_PROBE — drives each work bot's IPC /trigger handler (text response path armed).
param(
    [string]$EcoLog = 'C:\KAI\tools\oracle-discord\logs\ecosystem.log',
    [string]$Out = $env:FLEET_TEXT_PROBE_OUT,
    [string]$ScratchDir = $env:FLEET_BOOT_SCRATCH
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not $ScratchDir) {
    $ScratchDir = 'C:\Users\revry\AppData\Local\Temp\grok-goal-d07e950bed3b\implementer'
}
if (-not $Out) {
    $Out = Join-Path $ScratchDir 'fleet-text-response-probe.txt'
}
New-Item -ItemType Directory -Force -Path (Split-Path $Out -Parent) | Out-Null

$targets = @(
    @{ name = 'KAI'; port = 3401 },
    @{ name = 'Groq'; port = 3405 },
    @{ name = 'Analyst'; port = 3406 },
    @{ name = 'Researcher'; port = 3407 },
    @{ name = 'Kai Coder'; port = 3408 }
)

$nonce = "text-probe-$(Get-Date -Format 'yyyyMMddHHmmss')"
$lines = @(
    "=== FLEET TEXT RESPONSE PROBE $(Get-Date -Format o) ===",
    "nonce=$nonce",
    "eco_log=$EcoLog",
    ""
)

$tailBefore = 0
if (Test-Path $EcoLog) {
    $tailBefore = (Get-Content $EcoLog -Encoding UTF8).Count
}

$allOk = $true
foreach ($t in $targets) {
    $ok = $false
    $detail = ''
    try {
        $body = @{ type = 'TEXT_PROBE'; nonce = $nonce } | ConvertTo-Json -Compress
        Invoke-WebRequest -Uri ("http://127.0.0.1:$($t.port)/trigger") -Method POST -Body $body -ContentType 'application/json' -UseBasicParsing -TimeoutSec 5 | Out-Null
        Start-Sleep -Milliseconds 600
        if (Test-Path $EcoLog) {
            $post = Get-Content $EcoLog -Encoding UTF8 | Select-Object -Skip $tailBefore
            $pat = "\[$([regex]::Escape($t.name))/TextProbe\] pong nonce=$nonce"
            $hit = $post | Where-Object { $_ -match $pat } | Select-Object -First 1
            if ($hit) { $ok = $true; $detail = $hit.Trim() }
            else { $detail = 'no log line yet' }
        } else {
            $detail = 'ecosystem.log missing'
        }
    } catch {
        $detail = "ERROR: $($_.Exception.Message)"
    }
    if (-not $ok) { $allOk = $false }
    $lines += "$($t.name):$($t.port) ok=$ok $detail"
}

$lines += ''
$lines += "probe_pass=$allOk"
$lines | Out-File $Out -Encoding utf8
Get-Content $Out
exit $(if ($allOk) { 0 } else { 1 })