# Audit human-voice evidence tiers — structural vs historical vs current-boot owner live.
param(
    [string]$EcoLog = 'C:\KAI\tools\oracle-discord\logs\ecosystem.log',
    [string]$ScratchDir = $env:FLEET_BOOT_SCRATCH,
    [string]$Out = $env:FLEET_HUMAN_VOICE_TIER_OUT
)

$ErrorActionPreference = 'Stop'
if (-not $ScratchDir) {
    $ScratchDir = 'C:\Users\revry\AppData\Local\Temp\grok-goal-d07e950bed3b\implementer'
}
if (-not $Out) {
    $Out = Join-Path $ScratchDir 'fleet-human-voice-tier-audit.txt'
}

$Root = Split-Path $PSScriptRoot -Parent
. (Join-Path $Root 'tools\oracle-discord\shared\fleet-log-classifier.ps1')

$bootLine = Get-FleetEcoBootLine $EcoLog
$post = Get-FleetEcoPostBootLines $EcoLog $bootLine
$postText = ($post | ForEach-Object { $_.Line }) -join "`n"

$probeLines = @($post | Where-Object { $_.Line -match 'speaker=Probe|probe-inject|Leo voice path probe' })
$humanPost = Get-FleetHumanVoiceEvidence -EcoLog $EcoLog -BootLine $bootLine
$humanAll = Get-FleetHumanVoiceEvidence -EcoLog $EcoLog -BootLine 1

$structuralProbe = ($probeLines.Count -gt 0) -and ($postText -match 'VoicePath/Probe.*responded')
$currentBootHuman = ($humanPost.human_line_count -gt 0)
$historicalHuman = ($humanAll.human_line_count -gt 0)

$lines = @(
    "=== FLEET HUMAN VOICE TIER AUDIT $(Get-Date -Format o) ===",
    "boot_line=$bootLine",
    "eco_log=$EcoLog",
    '',
    'TIER_1_structural_probe_inject=' + $(if ($structuralProbe) { 'PASS' } else { 'FAIL' }),
    "  probe_line_count_post_boot=$($probeLines.Count)",
    '  proves=listener capture-reuse chain + skip_capture + forceTts (synthetic PCM/transcript)',
    '  does_NOT_prove=real Discord mic or gemini-live human path in current boot',
    '',
    'TIER_2_historical_real_human_gemini_live=' + $(if ($historicalHuman) { 'PASS' } else { 'FAIL' }),
    "  human_line_count_full_log=$($humanAll.human_line_count)",
    "  gate_open_count=$($humanAll.gate_open.Count)",
    "  mic_level_count=$($humanAll.mic_level.Count)",
    '  path=gemini-live (GATE OPEN Ryan + MicLevel frames to Gemini + GATE CLEAR transcripts)',
    '  see_also=human-voice-real-evidence.txt',
    '',
    'TIER_3_current_boot_owner_live=' + $(if ($currentBootHuman) { 'PASS' } else { 'PENDING' }),
    "  human_line_count_post_boot=$($humanPost.human_line_count)",
    '  blocker_if_fail=user likely MUTED — run tools/owner-voice-ear-check.ps1 -WaitSec 90 after unmute',
    '  stutter_feel=owner ear only',
    '',
    '=== POST-BOOT HUMAN LINES (last 10) ==='
) + @($humanPost.lines | Select-Object -Last 10 | ForEach-Object { "L$($_.LineNumber): $($_.Line.Trim())" })

if (-not $currentBootHuman -and $historicalHuman) {
    $lines += ''
    $lines += '=== HISTORICAL HUMAN SAMPLE (full log, last 6) ==='
    $lines += @($humanAll.lines | Select-Object -Last 6 | ForEach-Object { "L$($_.LineNumber): $($_.Line.Trim())" })
}

$dir = Split-Path $Out -Parent
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$lines | Out-File $Out -Encoding utf8
Get-Content $Out
exit $(if ($structuralProbe -and $historicalHuman) { 0 } else { 1 })