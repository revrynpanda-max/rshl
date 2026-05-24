# Hard Reset Script for KAI Ecosystem
Write-Host "[Reset] Hard-resetting KAI Sovereign Ecosystem..." -ForegroundColor Cyan

# 1. Kill all relevant processes
Write-Host "[Reset] Killing Node, KAI, and Gateway processes..."
Stop-Process -Name node -Force -ErrorAction SilentlyContinue
Stop-Process -Name kai -Force -ErrorAction SilentlyContinue
$port3334 = Get-NetTCPConnection -LocalPort 3334 -ErrorAction SilentlyContinue
if ($port3334) { Stop-Process -Id $port3334.OwningProcess -Force -ErrorAction SilentlyContinue }
$port3410 = Get-NetTCPConnection -LocalPort 3410 -ErrorAction SilentlyContinue
if ($port3410) { Stop-Process -Id $port3410.OwningProcess -Force -ErrorAction SilentlyContinue }

# 2. Wipe state and lock files
Write-Host "[Reset] Wiping state, locks, and interaction flags..."
$stateDir = "c:\KAI\tools\oracle-discord\state"
$filesToWipe = @(
    "self_optimize_state.json",
    "user_interaction.flag",
    "neural_lock.json",
    "late_night_override.flag",
    "eod_sent.json"
)
foreach ($file in $filesToWipe) {
    $path = Join-Path $stateDir $file
    if (Test-Path $path) { Remove-Item $path -Force; Write-Host "  Wiped: $file" }
}

# 3. Unload heavy Ollama models to reclaim RAM
Write-Host "[Reset] Reclaiming 17GB+ RAM from Ollama..."
ollama unload Kai-Coder-Sovereign:latest 2>&1 | Out-Null
ollama gc 2>&1 | Out-Null

Write-Host "[Reset] System purged. Ready for fresh boot." -ForegroundColor Green
