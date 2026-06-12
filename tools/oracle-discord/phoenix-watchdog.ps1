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

if ($engineAlive -or $managerAlive) {
    # At least one heart beats — the inner layers (manager respawn, KAI
    # failsafe, Oracle commands) can handle partial failures. Stand down.
    exit 0
}

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

# Relaunch using the detached hidden launcher (no visible cmd/ps window flash)
$detached = "C:\KAI\tools\oracle-discord\launch-detached.ps1"
if (Test-Path $detached) {
    Start-Process -FilePath "powershell" -ArgumentList "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$detached`"" -WindowStyle Hidden
    Log "Relaunch spawned via launch-detached (fully hidden)."
} else {
    # Fallback - still try to be hidden
    Start-Process -FilePath "powershell" -ArgumentList "-WindowStyle Hidden -ExecutionPolicy Bypass -Command `"cd 'C:\KAI\tools\oracle-discord'; .\run-oracle-discord.ps1`"" -WindowStyle Hidden
    Log "Relaunch spawned (fallback hidden)."
}
