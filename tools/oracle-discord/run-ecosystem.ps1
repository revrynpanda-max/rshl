# run-ecosystem.ps1
# Starts the Oracle Gateway and all independent AI bots inside a single manager window

Write-Host "Starting Oracle Ecosystem Manager..." -ForegroundColor Cyan

# Start the unified ecosystem manager
node ecosystem-manager.mjs

Write-Host "`nEcosystem Manager exited." -ForegroundColor Red
