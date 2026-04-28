# KAI Master Launcher
# Starts the Oracle Roundtable server and the KAI TUI interface simultaneously.

Write-Host "--- KAI Strategic Command ---" -ForegroundColor Cyan
Write-Host "Initializing lattice and starting roundtable server..."

# 1. Start the Oracle Server in the background
$oracle_process = Start-Process cargo -ArgumentList "run", "--release", "--", "--oracle" -NoNewWindow -PassThru
Write-Host "Oracle Server active on http://127.0.0.1:8765" -ForegroundColor Green

# 2. Open the Command Center UI
Start-Process "oracle.html"

# 3. Start the KAI TUI in a NEW window
Write-Host "Launching KAI TUI in separate terminal..." -ForegroundColor Green
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cargo run --release"

Write-Host "Both systems active." -ForegroundColor Yellow
Write-Host "Press Ctrl+C to stop the Oracle server." -ForegroundColor Yellow

try {
    while ($true) { Start-Sleep -Seconds 1 }
}
finally {
    Write-Host "Shutting down Oracle server..." -ForegroundColor Red
    Stop-Process -Id $oracle_process.Id -Force
}
