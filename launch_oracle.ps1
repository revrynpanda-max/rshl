# KAI Master Launcher
# Starts the KAI engine (with built-in Oracle server) and opens the diagnostic UI.

Write-Host "--- KAI Strategic Command ---" -ForegroundColor Cyan
Write-Host "Initializing KAI engine and Oracle Roundtable..."

# 1. Launch KAI engine HEADLESS (no visible console window for the service)
Write-Host "Launching KAI Engine (headless)..." -ForegroundColor Green
$kai_process = Start-Process -FilePath "powershell" `
    -ArgumentList "-WindowStyle Hidden -ExecutionPolicy Bypass -Command `"cd 'C:\KAI'; cargo run --release --bin kai -- --oracle-server`"" `
    -WindowStyle Hidden -PassThru

# 2. Wait a moment for the server to bind port 3333
Start-Sleep -Seconds 4

# 3. Start the dashboard web server (serves oracle.html on :3001 AND proxies /api to
#    the engine on :3334), then open the SERVED url. Opening oracle.html as a file://
#    breaks every /api call (origin becomes "null"), so the roundtable ONLY works over
#    http://localhost:3001. (The canonical entry point is Start-KAI.ps1, which starts
#    the engine + fleet + this dashboard in order — this is the standalone fallback.)
Write-Host "Starting Oracle dashboard server (:3001)..." -ForegroundColor Green
$dashUp = $false
try { Invoke-WebRequest "http://localhost:3001/health" -TimeoutSec 2 -UseBasicParsing | Out-Null; $dashUp = $true } catch {}
if (-not $dashUp) {
    Start-Process -FilePath "node" -ArgumentList "C:\KAI\tools\oracle-discord\dashboard-server.mjs" -WindowStyle Hidden
    Start-Sleep -Seconds 2
}
Write-Host "Opening Oracle Roundtable UI at http://localhost:3001 ..." -ForegroundColor Green
Start-Process "http://localhost:3001"

# 4. Launch OpenJarvis Brain HEADLESS via the project's own detached launcher if present, else hidden
Write-Host "Launching OpenJarvis Brain (headless)..." -ForegroundColor Cyan
$ojDetached = "c:\KAI\OpenJarvis-main\launch-detached.ps1"
if (Test-Path $ojDetached) {
    Start-Process -FilePath "powershell" -ArgumentList "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ojDetached`"" -WindowStyle Hidden -PassThru | Out-Null
} else {
    Push-Location "c:\KAI\OpenJarvis-main"
    Start-Process -FilePath "powershell" `
        -ArgumentList "-WindowStyle Hidden -ExecutionPolicy Bypass -Command `"uv run jarvis start`"" `
        -WindowStyle Hidden -PassThru | Out-Null
    Pop-Location
}

Write-Host "--- Systems Active (headless where possible) ---" -ForegroundColor Yellow
Write-Host "Oracle Engine API: http://127.0.0.1:3334"
Write-Host "OpenJarvis Brain: http://127.0.0.1:8080"
Write-Host "Roundtable UI: http://localhost:3001  (NOT the oracle.html file — must be the served URL)"
Write-Host "All heavy services launched with -WindowStyle Hidden to stop random console popups."
Write-Host "Use sovereign-start.ps1 or tools/oracle-discord/launch-detached.ps1 for full ecosystem."
