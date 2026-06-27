# BOOT-anchored fleet soak + storm audit — single consistent evidence window.
param(
    [int]$Minutes = 60,
    [int]$PollSec = 120,
    [string]$ScratchDir = $env:FLEET_BOOT_SCRATCH
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not $ScratchDir) {
    $ScratchDir = 'C:\Users\revry\AppData\Local\Temp\grok-goal-d07e950bed3b\implementer'
}
New-Item -ItemType Directory -Force -Path $ScratchDir | Out-Null

$Root = Split-Path $PSScriptRoot -Parent
$EcoLog = Join-Path $Root 'tools\oracle-discord\logs\ecosystem.log'
. (Join-Path $Root 'tools\oracle-discord\shared\fleet-health.ps1')
. (Join-Path $Root 'tools\oracle-discord\shared\fleet-log-classifier.ps1')
$OutSoak = Join-Path $ScratchDir 'runtime-soak-hour.txt'
$OutAudit = Join-Path $ScratchDir 'eco-storm-audit.txt'

function Get-BootLine {
    $hit = Select-String -Path $EcoLog -Pattern '\[Ecosystem/BOOT\]' -EA SilentlyContinue | Select-Object -Last 1
    if ($hit) { return $hit.LineNumber }
    return 0
}

$bootLine = Get-BootLine
$lines = @(
    "=== FLEET SOAK EVIDENCE $(Get-Date -Format o) ===",
    "boot_line=$bootLine",
    "poll_interval_sec=$PollSec",
    "duration_min=$Minutes",
    ""
)

$end = (Get-Date).AddMinutes($Minutes)
$failSamples = @()

# Gate: do not poll until essentials fleet is fully up (avoids boot-ramp fail_poll=1)
$readyBy = (Get-Date).AddSeconds(180)
Write-Host "[fleet-soak-evidence] Waiting for fleet ready (Leo connected, 8+ nodes)..."
while ((Get-Date) -lt $readyBy) {
    $mgr = $null
    try { $mgr = Get-Content (Join-Path $Root 'tools\oracle-discord\state\ecosystem-manager.json') -Raw | ConvertFrom-Json } catch {}
    $p3001 = [bool](netstat -ano | Select-String ':3001\s.*LISTENING')
    $nodeCount = @(Get-Process node -EA SilentlyContinue).Count
    $leo = $mgr.children | Where-Object { $_.name -eq 'Leo' } | Select-Object -First 1
    if ($p3001 -and $nodeCount -ge 8 -and $leo -and $leo.connected -and $leo.pid) {
        Write-Host "[fleet-soak-evidence] Fleet ready (nodes=$nodeCount LeoPid=$($leo.pid))"
        break
    }
    Start-Sleep -Seconds 5
}

while ((Get-Date) -lt $end) {
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $mgr = $null
    try { $mgr = Get-Content (Join-Path $Root 'tools\oracle-discord\state\ecosystem-manager.json') -Raw | ConvertFrom-Json } catch {}
    $p3001 = [bool](netstat -ano | Select-String ':3001\s.*LISTENING')
    $p3334 = Test-FleetEngineReady
    $p3401 = [bool](netstat -ano | Select-String ':3401\s.*LISTENING')
    $nodeCount = @(Get-Process node -EA SilentlyContinue).Count
    $leo = $mgr.children | Where-Object { $_.name -eq 'Leo' } | Select-Object -First 1

    $ecoAll = Get-Content $EcoLog -EA SilentlyContinue
    $ecoPostBoot = if ($bootLine -gt 0) { @($ecoAll | Select-Object -Skip ($bootLine - 1)) } else { $ecoAll }
    $tailPost = $ecoPostBoot | Select-Object -Last 60
    $tailExits = ($tailPost | Select-String 'exited with code').Count
    $tail429 = ($tailPost | Select-String '4294967295').Count
    $tailVoiceIn = ($tailPost | Select-String '\[Groq/VoiceIn\]|\[Gemini/VoiceIn\]|\[Claudey/VoiceIn\]|\[X/VoiceIn\]').Count
    $mgrAge = if ($mgr.updatedAt) { [int](((Get-Date) - [datetime]$mgr.updatedAt).TotalSeconds) } else { 9999 }
    $leoPidAlive = $false
    if ($leo -and $leo.pid) {
        $leoPidAlive = $null -ne (Get-Process -Id $leo.pid -ErrorAction SilentlyContinue)
    }
    $mgrStale = ($mgrAge -gt 120) -and (-not $leoPidAlive) -and ($nodeCount -lt 4)
    $ok = $p3001 -and $p3334 -and $p3401 -and $nodeCount -ge 8 -and $leo -and $leo.connected -and $leoPidAlive -and (-not $mgrStale) -and $tail429 -eq 0
    $line = "[$ts] OK=$ok ports(3001=$p3001 3334=$p3334 3401=$p3401) nodes=$nodeCount mgrAgeSec=$mgrAge LeoPid=$($leo.pid) LeoPidAlive=$leoPidAlive mgrStale=$mgrStale LeoConn=$($leo.connected) postBootTailExits=$tailExits postBootTail429=$tail429 socialVoiceIn=$tailVoiceIn"
    $lines += $line
    Write-Host $line
    if (-not $ok) { $failSamples += $line }
    Start-Sleep -Seconds $PollSec
}

# Post-soak counts — same boot_line window via shared classifier
$post = Get-FleetEcoPostBootLines $EcoLog $bootLine
$m = Measure-FleetLogClassification $post
$post429 = @($post | Where-Object { $_.Line -match '4294967295' })
$postExit = $m.fatal
$postVoiceIn = $m.voiceIn
$postGroqGemini = @($post | Where-Object { $_.Line -match '\[Groq\].*\[OpenJarvis/GEMINI\]' })

$lines += ''
$lines += '=== POST-SOAK SUMMARY (boot_line window only) ==='
$lines += "boot_line=$bootLine"
$lines += "post_boot_4294967295=$($post429.Count)"
$lines += "post_boot_exited_with_code=$($postExit.Count)"
$lines += "post_boot_social_voicein=$($postVoiceIn.Count)"
$lines += "post_boot_groq_gemini_hits=$($postGroqGemini.Count)"
$lines += "fail_poll_samples=$($failSamples.Count)"
if ($failSamples.Count -gt 0) { $lines += $failSamples }

$lines | Out-File $OutSoak -Encoding utf8

@(
    "=== ECOSYSTEM STORM AUDIT $(Get-Date -Format o) ===",
    "boot_line=$bootLine",
    "post_boot_4294967295=$($post429.Count)",
    "post_boot_exited_with_code=$($postExit.Count)",
    "post_boot_social_voicein=$($postVoiceIn.Count)",
    "post_boot_groq_gemini_hits=$($postGroqGemini.Count)",
    "last_5_post_boot_429:"
) + @($post429 | Select-Object -Last 5 | ForEach-Object { "  L$($_.LineNumber): $($_.Line.Trim())" }) |
    Out-File $OutAudit -Encoding utf8

Write-Host "[fleet-soak-evidence] DONE boot_line=$bootLine post429=$($post429.Count) fail_poll=$($failSamples.Count) -> $OutSoak"
exit $(if ($failSamples.Count -eq 0) { 0 } else { 1 })