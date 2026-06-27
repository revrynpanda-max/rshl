# Classify post-[Ecosystem/BOOT] log lines via shared fleet-log-classifier.ps1
param(
    [string]$Out = "C:\Users\revry\AppData\Local\Temp\grok-goal-d07e950bed3b\implementer\post-boot-error-audit.txt",
    [string]$EcoLog = "C:\KAI\tools\oracle-discord\logs\ecosystem.log"
)

$Root = Split-Path $PSScriptRoot -Parent
. (Join-Path $Root 'tools\oracle-discord\shared\fleet-log-classifier.ps1')

$bootLine = Get-FleetEcoBootLine $EcoLog
$post = Get-FleetEcoPostBootLines $EcoLog $bootLine
$m = Measure-FleetLogClassification $post

$lines = @(
    "=== POST-BOOT ERROR AUDIT $(Get-Date -Format o) ===",
    "classifier=fleet-log-classifier.ps1",
    "boot_line=$bootLine",
    "post_boot_lines=$($post.Count)",
    "fatal_count=$($m.fatal_count)",
    "handled_transient_count=$($m.handled_transient_count)",
    "allowed_boot_count=$($m.allowed_boot_count)",
    "social_voicein_count=$($m.social_voicein_count)",
    "",
    "=== FATAL (last 10) ==="
) + @($m.fatal | Select-Object -Last 10 | ForEach-Object { "L$($_.LineNumber): $($_.Line.Trim())" })

$lines += ""
$lines += "=== HANDLED_TRANSIENT (last 10) ==="
$lines += @($m.handled | Select-Object -Last 10 | ForEach-Object { "L$($_.LineNumber): $($_.Line.Trim())" })

$lines += ""
$lines += "=== SOCIAL VOICEIN (should be 0) ==="
$lines += @($m.voiceIn | ForEach-Object { "L$($_.LineNumber): $($_.Line.Trim())" })

$dir = Split-Path $Out -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$lines | Out-File $Out -Encoding utf8
Get-Content $Out
exit $(if ($m.fatal_count -gt 0 -or $m.social_voicein_count -gt 0) { 1 } else { 0 })