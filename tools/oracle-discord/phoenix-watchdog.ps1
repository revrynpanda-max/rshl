# ── PHOENIX WATCHDOG ─────────────────────────────────────────────────────────
# The outside-the-tree resurrection layer. Runs from Windows Task Scheduler
# every 5 minutes — survives even TOTAL system death (engine, manager, fleet
# all gone), because the OS itself is the watchdog.
#
# Checks two pulses:
#   1. KAI engine answering on http://127.0.0.1:3334/api/status
#   2. Ecosystem manager state file freshness (< 5 minutes old)
# If BOTH are dead → relaunch the whole show via KAI-Start.bat.
#
# Register once (run in an elevated PowerShell) - uses -WindowStyle Hidden so NO random popup windows:
#   schtasks /Create /TN "KAI Phoenix Watchdog" /TR "powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -NoProfile -File C:\KAI\tools\oracle-discord\phoenix-watchdog.ps1" /SC MINUTE /MO 5 /F
# Remove with:
#   schtasks /Delete /TN "KAI Phoenix Watchdog" /F
#
# This keeps the resurrection active (revives KAI silently when everything is down) without flashing PowerShell/cmd windows that look suspicious or interrupt your work.

$logFile = "C:\KAI\scratch\phoenix-watchdog.log"
function Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
    Add-Content -Path $logFile -Value $line -ErrorAction SilentlyContinue
}

# Pulse 1: engine
$engineAlive = $false
try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:3334/api/status" -UseBasicParsing -TimeoutSec 5
    if ($r.StatusCode -eq 200) { $engineAlive = $true }
} catch {}

# Pulse 2: manager state freshness
$managerAlive = $false
$statePath = "C:\KAI\tools\oracle-discord\state\ecosystem-manager.json"
if (Test-Path $statePath) {
    $age = (Get-Date) - (Get-Item $statePath).LastWriteTime
    if ($age.TotalMinutes -lt 5) { $managerAlive = $true }
}

# ── UPGRADED DECISION: crash-loop aware ──────────────────────────────────────
# Count recent bot exits in the ecosystem log. A burst of "exited with code"
# lines = a respawn storm (the crash loop). The classic cause is the engine
# dying: bots can't reach :3334, crash, get respawned straight back into the
# void, forever — all while the MANAGER stays alive, so the old "manager alive
# → stand down" rule never fired. That was the gap that let it loop unattended.
$recentExits = 0
$ecoLog = "C:\KAI\tools\oracle-discord\logs\ecosystem.log"
if (Test-Path $ecoLog) {
    try { $recentExits = (Get-Content $ecoLog -Tail 150 -EA SilentlyContinue | Select-String 'exited with code' -EA SilentlyContinue).Count } catch {}
}
$crashLooping = $recentExits -ge 15

# Healthy: engine + manager both beating AND no respawn storm → stand down.
if ($engineAlive -and $managerAlive -and -not $crashLooping) { exit 0 }

# PARTIAL FAILURE with the manager still ALIVE — either the engine is down
# (bots crash-looping on it) or a respawn storm is underway. Restarting the
# engine fixes both: bots reconnect to a fresh :3334 and the loop ends. We do
# NOT full-relaunch here (that would duplicate the live manager). Guard against
# restarting more than once per ~8 min so we don't thrash.
if ($managerAlive) {
    $engMarker = "C:\KAI\scratch\phoenix-engine-restart.txt"
    if ((Test-Path $engMarker) -and (((Get-Date) - (Get-Item $engMarker).LastWriteTime).TotalMinutes -lt 8)) {
        Log "Partial failure (engineAlive=$engineAlive, recentExits=$recentExits) but engine was restarted <8m ago — waiting for it to settle."
        exit 0
    }
    Set-Content -Path $engMarker -Value (Get-Date -Format 'o') -ErrorAction SilentlyContinue
    $scratch = "C:\KAI\scratch"
    $stderr  = "$scratch\oracle-discord-kai.err.log"
    if ((Test-Path $stderr) -and (Get-Item $stderr).Length -gt 0) {
        Copy-Item $stderr "$scratch\kai-crash-$(Get-Date -Format 'yyyyMMdd-HHmmss').err.log" -ErrorAction SilentlyContinue
    }
    Stop-Process -Name kai -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    $env:RUST_BACKTRACE = "1"
    $kaiExe = "C:\KAI\target\release\kai.exe"
    if (Test-Path $kaiExe) {
        Start-Process -FilePath $kaiExe -ArgumentList "--oracle" -WorkingDirectory "C:\KAI" -WindowStyle Hidden `
            -RedirectStandardOutput "$scratch\oracle-discord-kai.out.log" -RedirectStandardError $stderr | Out-Null
        Log "Partial failure (engineAlive=$engineAlive, manager ALIVE, recentExits=$recentExits). Restarted engine to break the crash loop; archived prior stderr for post-mortem."
    } else {
        Log "Engine restart needed but kai.exe missing at $kaiExe."
    }
    exit 0
}

# Manager is DOWN (engine up or down) → genuine total/structural death.
# Fall through to the storm-guarded full relaunch below.

# TOTAL DEATH detected. Guard against relaunch storms: only fire if we
# haven't fired in the last 10 minutes.
$markerPath = "C:\KAI\scratch\phoenix-last-fire.txt"
if (Test-Path $markerPath) {
    $sinceFire = (Get-Date) - (Get-Item $markerPath).LastWriteTime
    if ($sinceFire.TotalMinutes -lt 10) {
        Log "Total death detected but Phoenix fired $([int]$sinceFire.TotalMinutes)m ago — waiting."
        exit 0
    }
}

# === AUTHORIZED vs UNAUTHORIZED DEATH DISTINCTION (per user spec) ===
# Authorized = user intentionally stopped via correct commands (KAI-Stop.bat, Oracle stop, etc.)
#   → Create C:\KAI\state\authorized_stop.json with timestamp + "authorized": true
# Unauthorized / crash = engine+manager dead with no recent authorized marker
#   → Trigger recovery + log for bone-healing / Hebbian learning so the system can patch faults over time.
$authStopPath = "C:\KAI\state\authorized_stop.json"
$authorizedStop = $false
$authAgeMin = 30  # consider authorized if stop was within last 30 minutes
if (Test-Path $authStopPath) {
    try {
        $auth = Get-Content $authStopPath -Raw | ConvertFrom-Json
        $authTime = [datetime]$auth.timestamp
        $age = (Get-Date) - $authTime
        if ($age.TotalMinutes -lt $authAgeMin -and $auth.authorized -eq $true) {
            $authorizedStop = $true
            Log "Planned/authorized shutdown detected (age $([int]$age.TotalMinutes)m). Skipping resurrection. System will not auto-revive."
        }
    } catch {
        Log "Could not read authorized_stop marker: $_"
    }
}

if ($authorizedStop) {
    exit 0
}

Log "🔥 TOTAL DEATH detected (engine + manager both silent, NO recent authorized stop marker). PHOENIX RISING — relaunching the whole system."
Set-Content -Path $markerPath -Value (Get-Date -Format 'o') -ErrorAction SilentlyContinue

# Log structured recovery event so lattice / Hebbian / bone-healing mechanisms can learn and strengthen against this fault.
$recoveryLog = "C:\KAI\logs\system_recovery_events.jsonl"
$event = [pscustomobject]@{
    ts = (Get-Date).ToString("o")
    type = "unauthorized_death_recovery"
    engine_pulse = $engineAlive
    manager_pulse = $managerAlive
    reason = "both critical pulses dead with no authorized stop marker within ${authAgeMin}m"
    action = "silent_relaunch"
    previous_marker_age_min = if (Test-Path $authStopPath) { ([int]$age.TotalMinutes) } else { $null }
}
try { $event | ConvertTo-Json -Compress | Add-Content -Path $recoveryLog } catch {}

# Spawn the interactive prompt to ask the user
$promptScript = "C:\KAI\tools\oracle-discord\phoenix-prompt.ps1"
if (Test-Path $promptScript) {
    Start-Process -FilePath "powershell" -ArgumentList "-ExecutionPolicy Bypass -NoProfile -File `"$promptScript`"" -WindowStyle Normal
    Log "Spawned interactive Phoenix prompt for user input."
} else {
    Log "Could not find phoenix-prompt.ps1. Standing down to prevent unauthorized looping."
}
