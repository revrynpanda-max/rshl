<#
.SYNOPSIS
  Apply-and-restart helper for the KAI / Oracle Discord ecosystem.

  Folds the runtime steps into one action:
    1. Stop the fleet
    2. (one-time) Trim + shrink the bloated transcript DB
    3. (optional) Rebuild the Rust engine (cargo)
    4. Restart the fleet

.PARAMETER SkipTrim
  Skip the transcript-DB trim (use on every restart AFTER the first one — the
  trim only needs to run once; auto-retention keeps the DB bounded afterward).

.PARAMETER SkipBuild
  Skip the cargo engine rebuild (use when you only changed Node/bot files and
  don't need to recompile kai.exe).

.EXAMPLE
  # First time — trim the DB and rebuild the engine:
  powershell -ExecutionPolicy Bypass -File C:\KAI\apply-and-restart.ps1

.EXAMPLE
  # Normal restart later — no trim, no rebuild:
  powershell -ExecutionPolicy Bypass -File C:\KAI\apply-and-restart.ps1 -SkipTrim -SkipBuild
#>
[CmdletBinding()]
param(
    [switch]$SkipTrim,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$Root      = 'C:\KAI'
$DiscordDir = Join-Path $Root 'tools\oracle-discord'

function Step($n, $msg) { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }
function Ok($msg)        { Write-Host "    OK: $msg"   -ForegroundColor Green }
function Warn($msg)      { Write-Host "    WARN: $msg" -ForegroundColor Yellow }
function Fail($msg)      { Write-Host "    FAIL: $msg" -ForegroundColor Red }

Write-Host "==== KAI apply-and-restart ====" -ForegroundColor White
Write-Host "Root: $Root   SkipTrim=$SkipTrim   SkipBuild=$SkipBuild"

# ---- 1. STOP THE FLEET ------------------------------------------------------
Step 1 "Stopping the fleet (KAI-Stop.bat)..."
$stop = Join-Path $Root 'KAI-Stop.bat'
if (Test-Path $stop) {
    try { & cmd.exe /c "`"$stop`""; Ok "Fleet stop invoked." }
    catch { Warn "KAI-Stop.bat returned an error: $($_.Exception.Message)" }
    Start-Sleep -Seconds 3
} else {
    Warn "KAI-Stop.bat not found at $stop — stop the fleet manually before continuing."
}

# ---- 2. TRIM THE TRANSCRIPT DB (one-time) -----------------------------------
if (-not $SkipTrim) {
    Step 2 "Trimming the transcript DB (backs up first; ~90% shrink)..."
    $trim = Join-Path $DiscordDir 'trim-transcripts.mjs'
    if (Test-Path $trim) {
        Push-Location $DiscordDir
        try {
            Write-Host "    --- dry run (preview) ---" -ForegroundColor DarkGray
            & node 'trim-transcripts.mjs' '--dry-run'
            Write-Host "    --- executing trim ---" -ForegroundColor DarkGray
            & node 'trim-transcripts.mjs' '--yes'
            if ($LASTEXITCODE -eq 0) { Ok "Transcript DB trimmed." }
            else { Warn "trim-transcripts.mjs exited with code $LASTEXITCODE — check its output above." }
        } catch { Warn "Trim failed: $($_.Exception.Message)" }
        finally { Pop-Location }
    } else {
        Warn "trim-transcripts.mjs not found — skipping trim."
    }
} else {
    Step 2 "Skipping DB trim (-SkipTrim)."
}

# ---- 3. REBUILD THE ENGINE (cargo) ------------------------------------------
if (-not $SkipBuild) {
    Step 3 "Rebuilding the Rust engine (cargo build --release --bin kai)..."
    Push-Location $Root
    try {
        & cargo build --release --bin kai
        if ($LASTEXITCODE -eq 0) { Ok "Engine rebuilt — vitals will unfreeze + /health route is live." }
        else { Fail "cargo build failed (exit $LASTEXITCODE). Fix the build before restarting, or re-run with -SkipBuild to start on the old binary." ; Pop-Location ; exit 1 }
    } catch { Fail "cargo build error: $($_.Exception.Message)"; Pop-Location; exit 1 }
    finally { Pop-Location }
} else {
    Step 3 "Skipping engine rebuild (-SkipBuild)."
}

# ---- 4. RESTART THE FLEET ---------------------------------------------------
Step 4 "Starting the fleet (Start-KAI.ps1)..."
$start = Join-Path $Root 'Start-KAI.ps1'
if (Test-Path $start) {
    Ok "Handing off to Start-KAI.ps1 (it owns the fleet from here)."
    & $start
} else {
    Fail "Start-KAI.ps1 not found at $start — start the fleet manually."
    exit 1
}

Write-Host "`n==== done ====" -ForegroundColor White
Write-Host "Next: hard-refresh the dashboard (Ctrl+Shift+R), re-enter your control token, and talk to Leo in Discord voice to confirm the racing is gone." -ForegroundColor White
