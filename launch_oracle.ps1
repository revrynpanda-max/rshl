# KAI Master Launcher
# Starts the KAI engine (with built-in Oracle server) and opens the diagnostic UI.

Write-Host "--- KAI Strategic Command ---" -ForegroundColor Cyan
Write-Host "Initializing KAI engine and Oracle Roundtable..."

# 1. Launch KAI in a new window (this starts the TUI and the background Oracle server)
Write-Host "Launching KAI Engine..." -ForegroundColor Green
$kai_process = Start-Process powershell -ArgumentList "-NoExit", "-Command", "cargo run --release --bin kai" -PassThru

# 2. Wait a moment for the server to bind port 3333
Start-Sleep -Seconds 3

# 3. Open the Command Center UI (oracle.html)
Write-Host "Opening Oracle Diagnostic UI..." -ForegroundColor Green
Start-Process "oracle.html"

Write-Host "--- Systems Active ---" -ForegroundColor Yellow
Write-Host "Oracle Server is running on http://127.0.0.1:3333"
Write-Host "You can monitor KAI and talk to the AI Council in the browser window."
Write-Host "Press any key to close this launcher (KAI will keep running)."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
