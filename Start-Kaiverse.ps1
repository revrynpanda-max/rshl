# ============================================================================
#  Start-Kaiverse.ps1  —  KAIVERSE-only dev server
# ----------------------------------------------------------------------------
#  Starts ONLY the Command Center web server (port 3001) that serves the
#  KAIVERSE:  oracle.html  +  kaiverse.js  +  /textures/*.
#
#  It does NOT start: the bot fleet, the Rust engine (kai.exe), Ollama, the
#  overnight training pipeline, or any synaptogenesis — so you can iterate on
#  the 3D world fast and keep your PC cool. (/api/* calls just return
#  "engine offline" gracefully; the KAIVERSE still renders.)
#
#  RUN:   right-click this file -> "Run with PowerShell"
#         or in a terminal:   powershell -ExecutionPolicy Bypass -File .\Start-Kaiverse.ps1
#  STOP:  press Ctrl+C in this window.
#
#  After each kaiverse.js edit, just hard-refresh the browser (Ctrl+Shift+R) —
#  no need to restart this server (it serves the file fresh, no-cache).
# ============================================================================

$ServerDir = 'C:\KAI\tools\oracle-discord'
$Server    = 'command-center-server.mjs'
$Port      = 3001

Write-Host ''
Write-Host '  KAIVERSE-only server  (Command Center static files + /api proxy)' -ForegroundColor Cyan
Write-Host '  No bots - no engine - no training. Just the 3D world.' -ForegroundColor DarkGray
Write-Host ''

# Keep training/synaptogenesis OFF while iterating (engine + pipeline honor this).
$env:KAI_TRAINING_ENABLED = '0'
$env:CC_PORT = "$Port"

# Sanity: server present + node available.
$ServerPath = Join-Path $ServerDir $Server
if (-not (Test-Path $ServerPath)) {
  Write-Host "  ERROR: $Server not found at $ServerPath" -ForegroundColor Red
  Read-Host '  Press Enter to exit'; exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host '  ERROR: Node.js not found in PATH. Install Node or open a terminal where `node` works.' -ForegroundColor Red
  Read-Host '  Press Enter to exit'; exit 1
}

# If port 3001 is already held by an OLD node server, free it (and only node).
$conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conns) {
  $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -eq 'node') {
    Write-Host "  Port $Port busy - stopping the old node server (PID $($proc.Id))..." -ForegroundColor Yellow
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
  } elseif ($proc) {
    Write-Host "  Port $Port is held by '$($proc.ProcessName)' (PID $($proc.Id)) - not a node server." -ForegroundColor Yellow
    Write-Host '  Close it, or set a different port:  $env:CC_PORT=3002 then re-run.' -ForegroundColor Yellow
  }
}

Set-Location $ServerDir
Write-Host ''
Write-Host "  Serving:  http://localhost:$Port/" -ForegroundColor Green
Write-Host '  Edit kaiverse.js  ->  Ctrl+Shift+R in the browser to see changes.' -ForegroundColor DarkGray
Write-Host '  Stop:  Ctrl+C' -ForegroundColor DarkGray
Write-Host ''

# Open the browser, then run the server in the foreground (Ctrl+C stops it).
Start-Process "http://localhost:$Port/"
node $Server
