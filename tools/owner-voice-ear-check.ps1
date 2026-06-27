# Owner live-voice ear-check — greps ecosystem.log + /voice-ready for REAL human mic
# (excludes VOICE_PATH_PROBE / speaker=Probe / synthetic probe transcripts).
param(
    [string]$EcoLog = 'C:\KAI\tools\oracle-discord\logs\ecosystem.log',
    [int]$BootLine = 0,
    [int]$WaitSec = 0,
    [string]$Out = $env:OWNER_VOICE_EAR_CHECK_OUT,
    [string]$ScratchDir = $env:FLEET_BOOT_SCRATCH
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not $ScratchDir) {
    $ScratchDir = 'C:\Users\revry\AppData\Local\Temp\grok-goal-d07e950bed3b\implementer'
}
if (-not $Out) {
    $Out = Join-Path $ScratchDir 'owner-voice-ear-check.txt'
}

$Root = Split-Path $PSScriptRoot -Parent
. (Join-Path $Root 'tools\oracle-discord\shared\fleet-health.ps1')
. (Join-Path $Root 'tools\oracle-discord\shared\fleet-log-classifier.ps1')

function Test-ProbeLine([string]$Line) {
    if (-not $Line) { return $false }
    return $Line -match 'speaker=Probe|path=probe|probe-inject|VoicePath/Probe|Leo voice path probe|Voice path structural check'
}

function Get-HumanVoiceLines([object[]]$Lines) {
    $human = @()
    foreach ($hit in $Lines) {
        $line = if ($hit.Line) { $hit.Line } else { [string]$hit }
        if (Test-ProbeLine $line) { continue }
        if ($line -match 'GATE OPEN.*(Ryan|nastermodx)') { $human += $line; continue }
        if ($line -match '\[Leo/HumanVoice\] path=(gemini-live|fallback)') { $human += $line; continue }
        if ($line -match '\[Leo/MicLevel\].*OPENED.*frames sent to Gemini') { $human += $line; continue }
        if ($line -match 'GATE CLEAR — transcript ready') { $human += $line; continue }
        if ($line -match 'UNMUTED at') { $human += $line; continue }
    }
    return $human
}

if ($BootLine -le 0) {
    $BootLine = Get-FleetEcoBootLine $EcoLog
}

$baselineHumanAt = 0
$ownerMutedApi = $null
$ownerInVoiceApi = $null
try {
    $vr0 = Invoke-WebRequest -Uri 'http://127.0.0.1:3400/voice-ready' -UseBasicParsing -TimeoutSec 4
    $vj0 = $vr0.Content | ConvertFrom-Json
    $baselineHumanAt = [int64]$vj0.last_human_voice_at
    if ($null -ne $vj0.PSObject.Properties['owner_voice_muted']) {
        $ownerMutedApi = [bool]$vj0.owner_voice_muted
    }
    if ($null -ne $vj0.PSObject.Properties['owner_in_voice']) {
        $ownerInVoiceApi = [bool]$vj0.owner_in_voice
    }
} catch {}

$startLine = 0
if (Test-Path $EcoLog) {
    $startLine = (Get-Content $EcoLog -Encoding UTF8).Count
}

$ownerLivePass = $false
$voiceReadyHuman = $false
$waitDetail = 'wait_skipped'
$polls = 0

if ($WaitSec -gt 0) {
    $waitDetail = "polling ${WaitSec}s for live human voice"
    for ($t = 0; $t -lt $WaitSec; $t += 2) {
        $polls++
        try {
            $vr = Invoke-WebRequest -Uri 'http://127.0.0.1:3400/voice-ready' -UseBasicParsing -TimeoutSec 4
            $vj = $vr.Content | ConvertFrom-Json
            if ($vj.last_human_voice_at -gt $baselineHumanAt -and
                $vj.last_human_path -in @('gemini-live', 'fallback') -and
                $vj.last_human_speaker -and $vj.last_human_speaker -ne 'Probe') {
                $voiceReadyHuman = $true
                $ownerLivePass = $true
                break
            }
        } catch {}
        Start-Sleep -Seconds 2
    }
}

$post = Get-FleetEcoPostBootLines $EcoLog $BootLine
$humanLines = @(Get-HumanVoiceLines $post)
$logHumanPass = ($humanLines.Count -gt 0)

if (-not $ownerLivePass) {
    $ownerLivePass = $logHumanPass
}

$historicalHuman = @()
if (-not $ownerLivePass -and (Test-Path $EcoLog)) {
    $allLines = Select-String -Path $EcoLog -Pattern '.' -EA SilentlyContinue
    $historicalHuman = @(Get-HumanVoiceLines $allLines)
}
$historicalPass = ($historicalHuman.Count -gt 0)

$gateOpens = @($humanLines | Where-Object { $_ -match 'GATE OPEN' })
$micLevels = @($humanLines | Where-Object { $_ -match 'MicLevel|frames sent to Gemini' })
$humanVoice = @($humanLines | Where-Object { $_ -match 'HumanVoice' })
$gateClears = @($humanLines | Where-Object { $_ -match 'GATE CLEAR — transcript ready' })

$mutedDiag = @($post | Where-Object { $_.Line -match 'MUTED/DEAFENED' } | Select-Object -Last 1)
$userMuted = $false
$mutedDetail = ''
if ($mutedDiag) {
    $userMuted = $true
    $mutedDetail = $mutedDiag.Line.Trim()
}

$structuralNote = 'structural_probe_evidence=separate (VOICE_PATH_PROBE); this script checks REAL human mic only'
$stutterNote = 'stutter_feel=owner_ear_only (harness cannot judge audio quality)'

$lines = @(
    "=== OWNER VOICE EAR-CHECK $(Get-Date -Format o) ===",
    "boot_line=$BootLine",
    "eco_log=$EcoLog",
    "wait_sec=$WaitSec polls=$polls wait_detail=$waitDetail",
    "owner_live_pass=$ownerLivePass",
    "voice_ready_human=$voiceReadyHuman",
    "log_human_pass=$logHumanPass",
    "human_line_count=$($humanLines.Count)",
    "gate_open_count=$($gateOpens.Count)",
    "mic_level_count=$($micLevels.Count)",
    "human_voice_marker_count=$($humanVoice.Count)",
    "gate_clear_transcript_count=$($gateClears.Count)",
    "historical_human_in_log=$historicalPass",
    "historical_human_line_count=$($historicalHuman.Count)",
    "user_muted_in_voice=$userMuted",
    $(if ($null -ne $ownerMutedApi) { "owner_voice_muted_api=$ownerMutedApi" } else { 'owner_voice_muted_api=unavailable_restart_leo_for_field' }),
    $(if ($null -ne $ownerInVoiceApi) { "owner_in_voice_api=$ownerInVoiceApi" } else { 'owner_in_voice_api=unavailable' }),
    $(if ($mutedDetail) { "muted_diag=$mutedDetail" } else { 'muted_diag=none' }),
    $structuralNote,
    $stutterNote,
    '',
    '=== HUMAN VOICE LINES (post-boot, probe-excluded, last 12) ==='
) + @($humanLines | Select-Object -Last 12)

if ($historicalPass -and -not $ownerLivePass) {
    $lines += ''
    $lines += '=== HISTORICAL HUMAN VOICE (full log, earlier boots, last 8) ==='
    $lines += @($historicalHuman | Select-Object -Last 8)
}

if (-not $ownerLivePass) {
    $lines += ''
    if ($userMuted) {
        $lines += 'BLOCKER: Discord shows MUTED/DEAFENED — unmute mic before ear-check'
    }
    $lines += 'ACTION: Join Leo voice channel, unmute, say "Leo hello", re-run with -WaitSec 90'
    $lines += 'PASS requires: GATE OPEN or [Leo/HumanVoice] or MicLevel OPENED for non-Probe speaker'
}

$dir = Split-Path $Out -Parent
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$lines | Out-File $Out -Encoding utf8
Get-Content $Out
exit $(if ($ownerLivePass) { 0 } else { 1 })