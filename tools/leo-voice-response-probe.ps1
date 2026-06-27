# Leo voice readiness probe - structural response path evidence (no live Discord mic).
param(
    [string]$EcoLog = 'C:\KAI\tools\oracle-discord\logs\ecosystem.log',
    [int]$BootLine = 0,
    [int]$MinStableSec = 45,
    [string]$Out = $env:LEO_VOICE_PROBE_OUT,
    [string]$ScratchDir = $env:FLEET_BOOT_SCRATCH
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not $ScratchDir) {
    $ScratchDir = 'C:\Users\revry\AppData\Local\Temp\grok-goal-d07e950bed3b\implementer'
}
if (-not $Out) {
    $Out = Join-Path $ScratchDir 'leo-voice-response-probe.txt'
}

$Root = Split-Path $PSScriptRoot -Parent
. (Join-Path $Root 'tools\oracle-discord\shared\fleet-health.ps1')
. (Join-Path $Root 'tools\oracle-discord\shared\fleet-log-classifier.ps1')

function Test-GroqPlacementOk([string]$PostText) {
    return (
        ($PostText -match '\[Groq/RadioOut\]') -or
        ($PostText -match '\[Groq/Startup\].*TTS-output anchor') -or
        ($PostText -match 'Mic listener skipped .*Groq is text/radio-output only') -or
        ($PostText -match '\[Groq/Startup\] staying OUT of voice \(work_hours_no_human\)')
    )
}

function Wait-FleetBootStable {
    param([int]$MinSec = 45, [int]$MaxWaitSec = 120)
    for ($i = 0; $i -lt $MaxWaitSec; $i += 3) {
        if (-not (Test-FleetManagerPulse)) { Start-Sleep -Seconds 3; continue }
        try {
            $leo = (Invoke-WebRequest -Uri 'http://127.0.0.1:3400/health' -UseBasicParsing -TimeoutSec 4).Content | ConvertFrom-Json
            if ($leo.uptime_ms -ge ($MinSec * 1000)) { return $true }
        } catch {}
        Start-Sleep -Seconds 3
    }
    return $false
}

if ($BootLine -le 0) {
    $BootLine = Get-FleetEcoBootLine $EcoLog
}

$stableOk = Wait-FleetBootStable -MinSec $MinStableSec
if (-not $stableOk) {
    Write-Warning "Fleet manager stable-wait timed out (min=${MinStableSec}s) - continuing probe anyway."
}

$post = Get-FleetEcoPostBootLines $EcoLog $BootLine
$postText = ($post | ForEach-Object { $_.Line }) -join "`n"

$leoHealth = $false
$leoDetail = ''
$voiceReady = $false
$voiceReadyDetail = ''
$ipcProbeOk = $false
$ipcProbeDetail = ''
$voicePathOk = $false
$voicePathDetail = ''
try {
    $resp = Invoke-WebRequest -Uri 'http://127.0.0.1:3400/health' -UseBasicParsing -TimeoutSec 5
    $json = $resp.Content | ConvertFrom-Json
    $leoHealth = ($json.name -eq 'Leo')
    $leoDetail = "name=$($json.name) pid=$($json.pid) uptime_ms=$($json.uptime_ms)"
} catch {
    $leoDetail = "ERROR: $($_.Exception.Message)"
}

try {
    $vr = Invoke-WebRequest -Uri 'http://127.0.0.1:3400/voice-ready' -UseBasicParsing -TimeoutSec 5
    $vj = $vr.Content | ConvertFrom-Json
    $voiceReady = ($vj.bot -eq 'Leo') -and $vj.voice_anchored -and $vj.receiver_ready
    $voiceReadyDetail = "anchored=$($vj.voice_anchored) receiver=$($vj.receiver_ready) status=$($vj.connection_status) channel=$($vj.channel_id)"
} catch {
    $voiceReadyDetail = "ERROR: $($_.Exception.Message)"
}

$probeNonce = "leo-probe-$(Get-Date -Format 'yyyyMMddHHmmss')"
try {
    $body = @{ type = 'IPC_PROBE'; nonce = $probeNonce } | ConvertTo-Json -Compress
    Invoke-WebRequest -Uri 'http://127.0.0.1:3400/trigger' -Method POST -Body $body -ContentType 'application/json' -UseBasicParsing -TimeoutSec 5 | Out-Null
    Start-Sleep -Milliseconds 400
    $vr2 = Invoke-WebRequest -Uri 'http://127.0.0.1:3400/voice-ready' -UseBasicParsing -TimeoutSec 5
    $vj2 = $vr2.Content | ConvertFrom-Json
    $ipcProbeOk = ($vj2.last_ipc_probe_nonce -eq $probeNonce) -and ($vj2.last_ipc_probe_at -gt 0)
    $ipcProbeDetail = "sent=$probeNonce echoed=$($vj2.last_ipc_probe_nonce) at=$($vj2.last_ipc_probe_at)"
} catch {
    $ipcProbeDetail = "ERROR: $($_.Exception.Message)"
}

$voicePathNonce = "voice-path-$(Get-Date -Format 'yyyyMMddHHmmss')"
$tailBefore = 0
if (Test-Path $EcoLog) { $tailBefore = (Get-Content $EcoLog -Encoding UTF8).Count }
try {
    $vpBody = @{ type = 'VOICE_PATH_PROBE'; nonce = $voicePathNonce; transcript = 'Leo voice path probe' } | ConvertTo-Json -Compress
    Invoke-WebRequest -Uri 'http://127.0.0.1:3400/trigger' -Method POST -Body $vpBody -ContentType 'application/json' -UseBasicParsing -TimeoutSec 180 | Out-Null

    $vj3 = $null
    $ttsSpoken = $false
    for ($poll = 0; $poll -lt 60; $poll++) {
        Start-Sleep -Seconds 2
        try {
            $vr3 = Invoke-WebRequest -Uri 'http://127.0.0.1:3400/voice-ready' -UseBasicParsing -TimeoutSec 5
            $vj3 = $vr3.Content | ConvertFrom-Json
            if ($vj3.last_voice_path_probe_nonce -eq $voicePathNonce -and $vj3.last_voice_path_probe_tts_spoken -eq $true) {
                $ttsSpoken = $true
                break
            }
            if ($vj3.last_voice_path_probe_nonce -eq $voicePathNonce -and $vj3.last_voice_path_probe_stage -eq 'responded') {
                break
            }
        } catch {}
    }
    if (-not $vj3) {
        $vr3 = Invoke-WebRequest -Uri 'http://127.0.0.1:3400/voice-ready' -UseBasicParsing -TimeoutSec 5
        $vj3 = $vr3.Content | ConvertFrom-Json
    }

    $logListenerStart = $false
    $logCaptureEnd = $false
    $logListener = $false
    $logSkipReuse = $false
    $logResponded = $false
    $logPreGen = $false
    $logTtsSkip = $false
    if (Test-Path $EcoLog) {
        $postVp = Get-Content $EcoLog -Encoding UTF8 | Select-Object -Skip $tailBefore
        $logListenerStart = [bool]($postVp | Where-Object { $_ -match 'Speaking listener start .* path=(probe-inject|fallback)' } | Select-Object -First 1)
        $logCaptureEnd = [bool]($postVp | Where-Object { $_ -match 'Voice stream ended\. Processing' } | Select-Object -First 1)
        $logListener = [bool]($postVp | Where-Object { $_ -match 'Speaking listener delivered pre-captured pcm' } | Select-Object -First 1)
        $logSkipReuse = [bool]($postVp | Where-Object { $_ -match 'handleUserVoice reusing listener pcm skip_capture=true' } | Select-Object -First 1)
        $logResponded = [bool]($postVp | Where-Object { $_ -match 'VoicePath/Probe\] responded to input.*pipeline=full' } | Select-Object -First 1)
        $logPreGen = [bool]($postVp | Where-Object { $_ -match 'Pre-generating for Leo:.*Voice path structural check' } | Select-Object -First 1)
        $logTtsSkip = [bool]($postVp | Where-Object { $_ -match 'No human in any voice channel' } | Select-Object -First 1)
    }
    if (-not $ttsSpoken) {
        $ttsSpoken = ($vj3.last_voice_path_probe_tts_spoken -eq $true) -or ($logResponded -and $logPreGen)
    }
    $voicePathOk = ($vj3.last_voice_path_probe_nonce -eq $voicePathNonce) -and
        ($vj3.last_voice_path_probe_stage -eq 'responded') -and
        ($vj3.last_voice_path_probe_skip_capture -eq $true) -and
        ($vj3.last_voice_path_probe_from_listener -eq $true) -and
        $ttsSpoken -and
        $logListenerStart -and $logCaptureEnd -and $logListener -and $logSkipReuse -and
        $logResponded -and (-not $logTtsSkip)
    $voicePathDetail = "sent=$voicePathNonce stage=$($vj3.last_voice_path_probe_stage) skip_capture=$($vj3.last_voice_path_probe_skip_capture) from_listener=$($vj3.last_voice_path_probe_from_listener) tts_spoken=$ttsSpoken log_listener_start=$logListenerStart log_capture_end=$logCaptureEnd log_deliver=$logListener log_skip_reuse=$logSkipReuse log_responded=$logResponded log_pregen=$logPreGen stable_wait=$stableOk"
} catch {
    $voicePathDetail = "ERROR: $($_.Exception.Message)"
}

$mgr = $null
try {
    $mgr = Get-Content (Join-Path $Root 'tools\oracle-discord\state\ecosystem-manager.json') -Raw | ConvertFrom-Json
} catch {}
$leoChild = $mgr.children | Where-Object { $_.name -eq 'Leo' } | Select-Object -First 1
$leoPidAlive = $false
if ($leoChild -and $leoChild.pid) {
    $leoPidAlive = $null -ne (Get-Process -Id $leoChild.pid -ErrorAction SilentlyContinue)
}

$checks = [ordered]@{
    leo_ipc_health = $leoHealth
    leo_voice_ready_route = $voiceReady
    leo_ipc_probe_echo = $ipcProbeOk
    leo_voice_path_probe = $voicePathOk
    leo_manager_connected = [bool]($leoChild -and $leoChild.connected)
    leo_pid_alive = $leoPidAlive
    leo_voice_anchored = ($postText -match '\[Leo/Voice\] Successfully anchored')
    leo_connectivity_watch = ($postText -match '\[Leo/Net\] Connectivity watch armed')
    no_receiver_null = -not ($postText -match 'null \(reading .receiver.\)')
    no_social_gemini_live_boot = -not ($postText -match '\[GeminiLive\] Session setup: bot=Gemini')
    no_groq_voice_tag = -not ($postText -match '\[Groq/Voice\]')
    groq_placement_ok = $false
}

$groqBootLine = Get-FleetEcoBootLine $EcoLog
for ($g = 0; $g -lt 40; $g++) {
    $groqPost = Get-FleetEcoPostBootLines $EcoLog $groqBootLine
    $groqText = ($groqPost | ForEach-Object { $_.Line }) -join "`n"
    if (Test-GroqPlacementOk $groqText) {
        $checks.groq_placement_ok = $true
        break
    }
    Start-Sleep -Seconds 3
    $groqBootLine = Get-FleetEcoBootLine $EcoLog
}

$allOk = $true
$lines = @(
    "=== LEO VOICE RESPONSE PROBE $(Get-Date -Format o) ===",
    "boot_line=$BootLine",
    "eco_log=$EcoLog",
    "leo_ipc=$leoDetail",
    "leo_voice_ready=$voiceReadyDetail",
    "leo_ipc_probe=$ipcProbeDetail",
    "leo_voice_path_probe=$voicePathDetail",
    ""
)

foreach ($k in $checks.Keys) {
    $v = $checks[$k]
    if (-not $v) { $allOk = $false }
    $lines += "$k=$v"
}

$lines += ''
$lines += "probe_pass=$allOk"
$lines += 'TIER=structural_only (synthetic probe-inject; NOT real human mic)'
$lines += 'TIER_owner_live=tools/owner-voice-ear-check.ps1 -WaitSec 90 (requires unmuted Discord mic)'
$lines += 'TIER_primary_human_path=gemini-live when Live available; fallback only when Live off'
$lines += "probe_transcript=synthetic fixed string 'Leo voice path probe' by design"

$dir = Split-Path $Out -Parent
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$lines | Out-File $Out -Encoding utf8
Get-Content $Out
exit $(if ($allOk) { 0 } else { 1 })