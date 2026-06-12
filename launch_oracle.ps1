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

# 3. Open the Command Center UI (oracle.html) — this one is intentionally visible (diagnostic)
Write-Host "Opening Oracle Diagnostic UI..." -ForegroundColor Green
Start-Process "oracle.html"

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
Write-Host "Oracle Server: http://127.0.0.1:3333 (or 3334)"
Write-Host "OpenJarvis Brain: http://127.0.0.1:8080"
Write-Host "Diagnostic UI: oracle.html (visible for you)"
Write-Host "All heavy services launched with -WindowStyle Hidden to stop random console popups."
Write-Host "Use sovereign-start.ps1 or tools/oracle-discord/launch-detached.ps1 for full ecosystem."
