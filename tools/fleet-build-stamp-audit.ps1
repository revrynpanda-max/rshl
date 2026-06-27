# GATE 8: FLEET_BUILD reload proof in fresh ecosystem.log
param(
    [string]$EcoLog = 'C:\KAI\tools\oracle-discord\logs\ecosystem.log',
    [string]$Out = $env:FLEET_BUILD_AUDIT_OUT,
    [string]$ScratchDir = $env:FLEET_BOOT_SCRATCH
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not $ScratchDir) {
    $ScratchDir = 'C:\Users\revry\AppData\Local\Temp\grok-goal-d07e950bed3b\implementer'
}
if (-not $Out) {
    $Out = Join-Path $ScratchDir 'fleet-build-stamp-audit.txt'
}

$Root = Split-Path $PSScriptRoot -Parent
$cargo = Join-Path $Root 'Cargo.toml'
$ver = 'v0.0.0'
if (Test-Path $cargo) {
    $m = Select-String -Path $cargo -Pattern '^version\s*=\s*"([^"]+)"' | Select-Object -First 1
    if ($m) { $ver = 'v' + $m.Matches[0].Groups[1].Value }
}

$required = @('Leo', 'Groq', 'Analyst')
$text = if (Test-Path $EcoLog) { Get-Content $EcoLog -Raw -Encoding UTF8 } else { '' }
$lines = @(
    "=== FLEET_BUILD STAMP AUDIT $(Get-Date -Format o) ===",
    "expected=$ver",
    "eco_log=$EcoLog",
    ""
)

$allOk = $true
foreach ($bot in $required) {
    $pat = "\[$bot/Ready\] FLEET_BUILD=$ver"
    $hit = $text -match $pat
    $lines += "$bot FLEET_BUILD=$ver found=$hit"
    if (-not $hit) { $allOk = $false }
}

$lines += ""
$lines += "stamp_pass=$allOk"
$dir = Split-Path $Out -Parent
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$lines | Out-File $Out -Encoding utf8
Get-Content $Out
exit $(if ($allOk) { 0 } else { 1 })