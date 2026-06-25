# Start-Dashboard.ps1  —  host ONLY the :3001 Oracle dashboard server.
#
#   Runs just command-center-server.mjs (the dashboard + /api/* + KAIVERSE host).
#   Does NOT start: the KAI engine, the Discord bots fleet, the overnight pipeline,
#   or Ollama. Use this to restart JUST the dashboard to pick up server-side (.mjs)
#   changes WITHOUT spawning the whole stack. Ctrl+C stops only the dashboard;
#   the engine + training keep running.
#
#   The dashboard still proxies the KAI engine on :3334 for live cell/vitals data,
#   so it LEAVES an already-running engine alone and just warns if :3334 is down.
#   (Drive/metacognition numbers come from the KAI bot on :3401 — if the fleet
#   isn't running, that one group shows honest n/a; everything else works.)

$ErrorActionPreference = 'Stop'
$Root      = $PSScriptRoot
$ServerDir = Join-Path $Root 'tools\oracle-discord'
$Server    = Join-Path $ServerDir 'command-center-server.mjs'
if (-not (Test-Path $Server)) { throw "Dashboard server not found at $Server" }

function Test-Port([int]$Port) {
    try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $Port); $c.Close(); return $true }
    catch { return $false }
}

# 1) Engine: leave it alone (the dashboard proxies :3334 for live lattice/vitals).
if (Test-Port 3334) {
    Write-Host "[engine] KAI already serving on :3334 - leaving it running (NOT relaunched)." -ForegroundColor Green
} else {
    Write-Host "[engine] :3334 not answering - dashboard will still host, but engine-backed data (cells/vitals/phi) shows n/a until KAI is up." -ForegroundColor DarkYellow
}

# 2) Free :3001 if an OLD dashboard node is still bound, so the NEW code loads.
$listeners = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
if ($listeners) {
    foreach ($op in ($listeners.OwningProcess | Sort-Object -Unique)) {
        $p = Get-Process -Id $op -ErrorAction SilentlyContinue
        if ($p -and $p.ProcessName -match 'node') {
            Write-Host "[server] stopping old dashboard on :3001 (PID $op) so the new code loads..." -ForegroundColor Yellow
            Stop-Process -Id $op -Force -ErrorAction SilentlyContinue
        }
    }
    Start-Sleep -Milliseconds 700
}

# 3) Ensure node deps exist (first run only).
if (-not (Test-Path (Join-Path $ServerDir 'node_modules'))) {
    Write-Host "[server] installing node dependencies (first run)..." -ForegroundColor Yellow
    Push-Location $ServerDir; npm install; Pop-Location
}

# 4) Host ONLY the dashboard server, in the foreground.
#    cwd = the server dir so it finds .env + node_modules exactly like the fleet does.
Write-Host ""
Write-Host "[server] hosting Oracle dashboard -> http://localhost:3001   (Ctrl+C to stop; engine + training keep running)" -ForegroundColor Green
Write-Host ""
Push-Location $ServerDir
try { node command-center-server.mjs } finally { Pop-Location }
