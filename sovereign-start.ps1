# KAI Sovereign Master Launcher
# One Command to Rule the CNS.

# Absolute encoding safety
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "--- KAI SOVEREIGN MASTER START ---" -ForegroundColor Cyan

# 1. CLEAN SLATE: Kill any existing KAI or Node processes to free up ports
Write-Host "[1/5] Clearing environment..." -ForegroundColor Yellow
Stop-Process -Name kai -Force -ErrorAction SilentlyContinue
Stop-Process -Name node -Force -ErrorAction SilentlyContinue

# Kill any leftover sensor processes
Get-WmiObject Win32_Process -Filter "Name='python.exe' OR Name='python3.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
    try {
        if ($_.CommandLine -like "*tinysa_bridge*" -or $_.CommandLine -like "*ir_bridge*" -or $_.CommandLine -like "*sensor_watchdog*") {
            $_.Terminate() | Out-Null
        }
    } catch {}
}

# Force-kill port 3333 or 3334 if still stuck
$port3333 = Get-NetTCPConnection -LocalPort 3333 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
if ($port3333) {
    Stop-Process -Id $port3333 -Force -ErrorAction SilentlyContinue
}
$port3334 = Get-NetTCPConnection -LocalPort 3334 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
if ($port3334) {
    Stop-Process -Id $port3334 -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2

# 2. START THE BRAIN: Launch Rust CNS in background
Write-Host "[2/5] Initializing 16,384-dimensional CNS..." -ForegroundColor Green
Start-Process -FilePath "./target/release/kai.exe" -ArgumentList "--oracle-server" -WindowStyle Hidden

# Wait for KAI CNS to initialize before attaching sensors
Write-Host "      Waiting 3s for CNS to initialize..." -ForegroundColor DarkGray
Start-Sleep -Seconds 3

# 3. START SENSORY LAYER: Launch RF and IR sensors as hidden background processes
Write-Host "[3/5] Launching Sensory Layer (RF + IR)..." -ForegroundColor Magenta

# TinySA Ultra RF bridge — silent headless mode, feeds RF anomalies to KAI
Write-Host "      [RF] Starting TinySA Ultra bridge on COM6..." -ForegroundColor DarkGray
Start-Process -FilePath "python" `
              -ArgumentList "C:\KAI\tools\tinysa_bridge.py --headless --port COM6" `
              -WindowStyle Hidden `
              -ErrorAction SilentlyContinue

# [DISABLED 2026-06-10] ir_bridge.py loops cv2.VideoCapture every 10s with no IR camera
# connected -> endless Windows device/permission sound. Uncomment when camera is attached.
# Write-Host "      [IR] Starting IR camera bridge..." -ForegroundColor DarkGray
# Start-Process -FilePath "python" `
#               -ArgumentList "C:\KAI\tools\ir_bridge.py --headless" `
#               -WindowStyle Hidden `
#               -ErrorAction SilentlyContinue

# 4. START WATCHDOG: Monitors sensors and auto-restarts if they crash
Write-Host "[4/5] Starting Sensor Watchdog..." -ForegroundColor Magenta
Start-Process -FilePath "powershell" `
              -ArgumentList "-WindowStyle Hidden -ExecutionPolicy Bypass -File C:\KAI\tools\sensors\sensor_watchdog.ps1" `
              -WindowStyle Hidden `
              -ErrorAction SilentlyContinue

Write-Host "      Sensory layer online: RF vision + IR thermal awareness active." -ForegroundColor DarkGray

# 5. START THE ECOSYSTEM: Launch Discord Multi-Bot loops
Write-Host "[5/5] Launching Sovereign Multi-Bot Ecosystem..." -ForegroundColor Green
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

# START ECOSYSTEM
Write-Host "--- SOVEREIGN SYSTEMS ACTIVE ---" -ForegroundColor Cyan
Write-Host "KAI is dreaming, working, and socializing."
Write-Host "Monitoring #kai-dreams for real-time evolution logs."
Write-Host ""
Write-Host "Active sensory organs:" -ForegroundColor Magenta
Write-Host "  [RF]  TinySA Ultra -> COM6 -> 87MHz-12GHz spectrum analysis" -ForegroundColor DarkGray
Write-Host "  [IR]  Thermal/IR camera -> presence + motion detection" -ForegroundColor DarkGray
Write-Host "  [WD]  Sensor watchdog -> auto-restart on crash" -ForegroundColor DarkGray
Write-Host ""

# START OPENJARVIS
Write-Host "      Starting OpenJarvis on port 8080..." -ForegroundColor DarkGray
$JarvisDir = "C:\KAI\OpenJarvis-main"
$scratch = "C:\KAI\scratch"
$logOut = "$scratch\openjarvis.out.log"
$logErr = "$scratch\openjarvis.err.log"
$env:OPENJARVIS_CONFIG = "$JarvisDir\configs\openjarvis\config.toml"
$uvPath = "C:\Users\revry\miniconda3\Scripts\uv.exe"
$defaultConfigDir = "$env:USERPROFILE\.openjarvis"
New-Item -ItemType Directory -Force -Path $defaultConfigDir | Out-Null
Copy-Item -Path $env:OPENJARVIS_CONFIG -Destination "$defaultConfigDir\config.toml" -Force
$env:KAI_LOCAL_ONLY = "1"
$oracleKeysFile = "C:\KAI\data\oracle_keys.json"
if (Test-Path $oracleKeysFile) {
    $oracleKeys = Get-Content $oracleKeysFile -Raw | ConvertFrom-Json
    if ($oracleKeys.groq)   { $env:GROQ_API_KEY   = $oracleKeys.groq }
    if ($oracleKeys.google) { $env:GOOGLE_API_KEY = $oracleKeys.google }
    if ($oracleKeys.openai) { $env:OPENAI_API_KEY = $oracleKeys.openai }
    if ($oracleKeys.xai)    { $env:XAI_API_KEY    = $oracleKeys.xai }
}
$env:OPENJARVIS_API_KEY = ""
if (-not $env:KAI_MODEL) { $env:KAI_MODEL = "kai-next:latest" }
Start-Process -FilePath $uvPath -ArgumentList "run", "jarvis", "serve", "--host", "127.0.0.1", "--port", "8080", "--engine", "ollama" -WorkingDirectory $JarvisDir -WindowStyle Hidden -RedirectStandardOutput $logOut -RedirectStandardError $logErr

# Run the FULL ecosystem manager (Social Time, Work Time, Fun Time)
Push-Location "C:\KAI\tools\oracle-discord"
.\run-ecosystem.ps1
Pop-Location

Write-Host "Starting log watcher..." -ForegroundColor Cyan
& "C:\KAI\tools\oracle-discord\watch-logs.ps1"

# The terminal watcher will auto-open your browser to the full rich web GUI (panels, easy mouse/scrolling, like this chat interface).
# Use that for the best "Grok GUI" experience with all logs, vitals, etc. The console one is a simple side-by-side log cameras view.
