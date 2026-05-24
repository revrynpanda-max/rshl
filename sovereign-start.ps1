# KAI Sovereign Master Launcher
# One Command to Rule the CNS.

# Absolute encoding safety
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "--- KAI SOVEREIGN MASTER START ---" -ForegroundColor Cyan

# 1. CLEAN SLATE: Kill any existing KAI or Node processes to free up ports
Write-Host "[1/4] Clearing environment..." -ForegroundColor Yellow
Stop-Process -Name kai -Force -ErrorAction SilentlyContinue
Stop-Process -Name node -Force -ErrorAction SilentlyContinue

# Force-kill port 3333 or 3334 if still stuck
$port3333 = Get-NetTCPConnection -LocalPort 3333 -ErrorAction SilentlyContinue
if ($port3333) {
    Stop-Process -Id $port3333.OwningProcess -Force -ErrorAction SilentlyContinue
}
$port3334 = Get-NetTCPConnection -LocalPort 3334 -ErrorAction SilentlyContinue
if ($port3334) {
    Stop-Process -Id $port3334.OwningProcess -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2

# 2. START THE BRAIN: Launch Rust CNS in background
Write-Host "[2/4] Initializing 16,384-dimensional CNS..." -ForegroundColor Green
Start-Process -FilePath "./target/release/kai.exe" -ArgumentList "--oracle-server" -WindowStyle Hidden

# 3. START THE ECOSYSTEM: Launch Discord Multi-Bot loops
Write-Host "[3/4] Launching Sovereign Multi-Bot Ecosystem..." -ForegroundColor Green
$env:ORACLE_API_URL = "http://127.0.0.1:3334"

# Load Tokens from .env
$envFile = "C:\KAI\tools\oracle-discord\.env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        $name, $value = $_.split('=', 2)
        if ($name -and $value) {
            [System.Environment]::SetEnvironmentVariable($name.Trim(), $value.Trim())
        }
    }
}

# 4. START ECOSYSTEM
Write-Host "--- SOVEREIGN SYSTEMS ACTIVE ---" -ForegroundColor Cyan
Write-Host "KAI is dreaming, working, and socializing."
Write-Host "Monitoring #kai-dreams for real-time evolution logs."

# Run the FULL ecosystem manager (Social Time, Work Time, Fun Time)
Push-Location "C:\KAI\tools\oracle-discord"
.\run-ecosystem.ps1
Pop-Location
