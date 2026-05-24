# Restart the KAI Oracle Ecosystem to apply architectural and logic updates
Write-Host "[Ecosystem] Initiating Global Reset..." -ForegroundColor Cyan

# 1. Kill existing node processes (bots and gateway)
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*oracle-discord*" } | Stop-Process -Force

# 2. Wait for ports to clear
Start-Sleep -Seconds 2

# 3. Re-run the main ecosystem manager
# Note: We assume we are in c:\KAI\tools\oracle-discord
node ecosystem-manager.mjs ALL
