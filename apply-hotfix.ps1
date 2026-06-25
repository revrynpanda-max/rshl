<#
================================================================================
  apply-hotfix.ps1  -  apply pending code edits to the running KAI ecosystem.
================================================================================
  WHAT IT DOES (in order, safely):
    1. Detects whether the Rust engine needs a REBUILD (any src\*.rs or Cargo.toml
       newer than target\release\kai.exe). Node/Python edits never need a rebuild.
    2. Stops the fleet.
    3. If a rebuild is needed: KILLS kai.exe first (so the binary is NOT locked =
       no "access denied"), then `cargo build --release --bin kai`. If the build
       FAILS, it logs the error and STILL restarts on the EXISTING (old) binary so
       the server is never left down — and tells you to hand the log to the dispatch.
    4. Restarts the fleet (Start-KAI.ps1). Node/Python edits take effect on this
       restart; oracle.html takes effect on a browser hard-refresh.

  USAGE:
    powershell -ExecutionPolicy Bypass -File C:\KAI\apply-hotfix.ps1
    -Force      : rebuild the engine even if the source looks unchanged
    -NoRebuild  : never rebuild (Node/Python-only hotfix) - fastest
    -NoStart    : stop + (rebuild) but don't relaunch (you start it yourself)

  Log: C:\KAI\scratch\apply-hotfix.log
================================================================================
#>
[CmdletBinding()]
param([switch]$Force, [switch]$NoRebuild, [switch]$NoStart)

$Root = 'C:\KAI'
Set-Location $Root
$scratch = Join-Path $Root 'scratch'
New-Item -ItemType Directory -Force -Path $scratch | Out-Null
$Log = Join-Path $scratch 'apply-hotfix.log'

function Say($m, $c='Gray'){ $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m; Write-Host $line -ForegroundColor $c; Add-Content -Path $Log -Value $line }

Say "==== apply-hotfix start (Force=$Force NoRebuild=$NoRebuild NoStart=$NoStart) ====" 'Cyan'

# ---- 1. Does the engine need a rebuild? --------------------------------------
$exe = Join-Path $Root 'target\release\kai.exe'
$needRebuild = $false
if ($NoRebuild) {
    Say "Rebuild check skipped (-NoRebuild)." 'DarkGray'
} elseif ($Force) {
    $needRebuild = $true; Say "Rebuild forced (-Force)." 'Yellow'
} elseif (-not (Test-Path $exe)) {
    $needRebuild = $true; Say "Engine binary missing -> rebuild required." 'Yellow'
} else {
    $exeTime = (Get-Item $exe).LastWriteTime
    $srcTime = $exeTime
    try {
        $newest = Get-ChildItem (Join-Path $Root 'src') -Recurse -Include *.rs -ErrorAction SilentlyContinue |
                  Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($newest) { $srcTime = $newest.LastWriteTime }
        $ct = Get-Item (Join-Path $Root 'Cargo.toml') -ErrorAction SilentlyContinue
        if ($ct -and $ct.LastWriteTime -gt $srcTime) { $srcTime = $ct.LastWriteTime }
    } catch {}
    if ($srcTime -gt $exeTime) { $needRebuild = $true; Say "Rust source is newer than the binary -> rebuild needed." 'Yellow' }
    else { Say "Engine binary is up to date -> no rebuild." 'Green' }
}

# ---- 2. Stop the fleet ------------------------------------------------------
Say "Stopping the fleet..." 'Yellow'
$stop = Join-Path $Root 'KAI-Stop.bat'
if (Test-Path $stop) { try { & cmd.exe /c "`"$stop`"" | Out-Null } catch {} ; Start-Sleep 3 }
# belt-and-suspenders: stop stray node + the engine (the engine MUST die before a build)
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 1

# ---- 3. Rebuild if needed (kill engine first = no access-denied) ------------
if ($needRebuild) {
    Say "Ensuring kai.exe is stopped so the binary is unlocked..." 'Yellow'
    Get-Process kai -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep 2
    Say "Building engine: cargo build --release --bin kai ..." 'Yellow'
    $out = & cargo build --release --bin kai 2>&1
    $out | ForEach-Object { Add-Content -Path $Log -Value $_ }
    $joined = ($out | Out-String)
    $compileFailed = ($joined -match 'error\[E\d+\]' -or $joined -match 'error:\s' -or $joined -match 'could not compile')
    $accessDenied  = ($joined -match 'Access is denied' -or $joined -match 'os error 5' -or $joined -match 'failed to remove')
    if ($accessDenied) {
        Say "ACCESS DENIED during build (binary still locked). Killing kai.exe again and retrying ONCE..." 'Red'
        Get-Process kai -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep 3
        $out = & cargo build --release --bin kai 2>&1
        $out | ForEach-Object { Add-Content -Path $Log -Value $_ }
        $joined = ($out | Out-String)
        $compileFailed = ($joined -match 'error\[E\d+\]' -or $joined -match 'could not compile')
        $accessDenied  = ($joined -match 'Access is denied' -or $joined -match 'os error 5')
    }
    if ($compileFailed) {
        Say "BUILD FAILED (compile error). Starting on the EXISTING (old) binary so the server stays up." 'Red'
        Say "ACTION: hand C:\KAI\HOTFIX-NOTES.md + the tail of this log to the dispatch to fix the Rust error." 'Red'
    } elseif ($accessDenied) {
        Say "BUILD still ACCESS-DENIED. Old binary will be used. ACTION: open Task Manager, end any 'kai.exe', then re-run this script. Or hand to dispatch." 'Red'
    } else {
        Say "Engine built OK." 'Green'
    }
}

# ---- 4. Restart ------------------------------------------------------------
if ($NoStart) {
    Say "Not restarting (-NoStart). Run Start-KAI.ps1 yourself when ready." 'DarkGray'
} else {
    $start = Join-Path $Root 'Start-KAI.ps1'
    if (Test-Path $start) {
        Say "Starting the fleet (Start-KAI.ps1)..." 'Green'
        & $start
    } else { Say "Start-KAI.ps1 not found - start the fleet manually." 'Red' }
}

Say "==== apply-hotfix done ====" 'Cyan'
Write-Host "`nNext: hard-refresh the dashboard (Ctrl+Shift+R). If the log shows a BUILD FAILED, the engine is on the OLD binary - send HOTFIX-NOTES.md + scratch\apply-hotfix.log to the dispatch." -ForegroundColor White
