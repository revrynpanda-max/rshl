# KAI Sensor Watchdog
# Monitors tinysa_bridge.py and ir_bridge.py.
# If either crashes, restarts it automatically.
# Optimized to run with 0% CPU by using native PID tracking instead of heavy WMI polling.

param(
    [string]$TinySAPort = "COM6"
)

$TinySAScript  = "C:\KAI\tools\tinysa_bridge.py"
$IRScript      = "C:\KAI\tools\ir_bridge.py"
$PythonExe     = "python"
$CheckInterval = 30    # seconds between checks
$LogFile       = "C:\KAI\logs\sensor_watchdog.log"

$TinySAPid = $null
$IRPid     = $null

# Ensure log directory exists
if (-not (Test-Path "C:\KAI\logs")) {
    New-Item -ItemType Directory -Path "C:\KAI\logs" -Force | Out-Null
}

function Write-Log {
    param([string]$msg)
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$ts  $msg" | Tee-Object -FilePath $LogFile -Append | Write-Host
}

# Startup Initialization: Find existing PIDs once to avoid WMI overhead later
try {
    $procs = Get-CimInstance -ClassName Win32_Process -Filter "Name='python.exe' OR Name='python3.exe'" -ErrorAction SilentlyContinue
    foreach ($p in $procs) {
        if ($p.CommandLine -and $p.CommandLine -like "*tinysa_bridge*") {
            $TinySAPid = $p.ProcessId
            Write-Log "Found existing tinysa_bridge process (PID: $TinySAPid)"
        }
        if ($p.CommandLine -and $p.CommandLine -like "*ir_bridge*") {
            $IRPid = $p.ProcessId
            Write-Log "Found existing ir_bridge process (PID: $IRPid)"
        }
    }
} catch {
    Write-Log "CIM startup lookup skipped or failed: $_"
}

function Is-PidRunning {
    param($pid)
    if (-not $pid) { return $false }
    return (Get-Process -Id $pid -ErrorAction SilentlyContinue) -ne $null
}

function Start-Sensor {
    param([string]$scriptPath, [string]$extraArgs = "")
    $args = "--headless $extraArgs".Trim()
    Write-Log "RESTART: Starting $scriptPath $args"
    $p = Start-Process -FilePath $PythonExe `
                  -ArgumentList "$scriptPath $args" `
                  -PassThru `
                  -WindowStyle Hidden `
                  -ErrorAction SilentlyContinue
    if ($p) {
        return $p.Id
    }
    return $null
}

Write-Log "=== KAI Sensor Watchdog Started ==="
Write-Log "Monitoring: tinysa_bridge.py | ir_bridge.py"
Write-Log "Check interval: ${CheckInterval}s"

while ($true) {
    # ── Check TinySA bridge ───────────────────────────────────────────────────
    if (-not (Is-PidRunning $TinySAPid)) {
        Write-Log "WARNING: tinysa_bridge.py is NOT running. Restarting..."
        $TinySAPid = Start-Sensor $TinySAScript "--port $TinySAPort"
    }

    # ── Check IR bridge ───────────────────────────────────────────────────────
    if (-not (Is-PidRunning $IRPid)) {
        Write-Log "WARNING: ir_bridge.py is NOT running. Restarting..."
        $IRPid = Start-Sensor $IRScript
    }

    Start-Sleep -Seconds $CheckInterval
}
