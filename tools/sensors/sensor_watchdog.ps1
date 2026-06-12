# KAI Sensor Watchdog
# Monitors tinysa_bridge.py and ir_bridge.py.
# If either crashes, restarts it automatically.
# Optimized to run with 0% CPU by using native PID tracking instead of heavy WMI polling.

param(
    [string]$TinySAPort = "COM6",
    [switch]$EnablePhoneBridge,
    [string]$PhoneHost = "127.0.0.1",
    [int]$PhonePort = 8787,
    [string]$PhoneToken = $env:KAI_PHONE_SENSOR_TOKEN,
    [ValidateSet("local", "tailnet", "any")]
    [string]$PhoneAllowSource = "any",
    [int]$MaxRestartFailures = 3,
    [int]$RestartCooldownSeconds = 600
)

$TinySAScript  = "C:\KAI\tools\tinysa_fusion_bridge.py"
$IRScript      = "C:\KAI\tools\ir_bridge.py"
$PhoneScript   = "C:\KAI\tools\phone_sensor_bridge.py"
$PythonExe     = "python"
$CheckInterval = 30    # seconds between checks
$LogFile       = "C:\KAI\logs\sensor_watchdog.log"

$TinySAPid = $null
$IRPid     = $null
$RFCamPid  = $null
$PhonePid  = $null
$RFScript  = "C:\KAI\tools\rf_camera_bridge.py"
$TinySAFailures = 0
$TinySACooldownUntil = $null

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
        if ($p.CommandLine -and $p.CommandLine -like "*tinysa_fusion_bridge*") {
            $TinySAPid = $p.ProcessId
            Write-Log "Found existing tinysa_fusion_bridge process (PID: $TinySAPid)"
        }
        if ($p.CommandLine -and $p.CommandLine -like "*ir_bridge*") {
            $IRPid = $p.ProcessId
            Write-Log "Found existing ir_bridge process (PID: $IRPid)"
        }
        if ($p.CommandLine -and $p.CommandLine -like "*rf_camera_bridge*") {
            $RFCamPid = $p.ProcessId
            Write-Log "Found existing rf_camera_bridge process (PID: $RFCamPid)"
        }
        if ($p.CommandLine -and $p.CommandLine -like "*phone_sensor_bridge*") {
            $PhonePid = $p.ProcessId
            Write-Log "Found existing phone_sensor_bridge process (PID: $PhonePid)"
        }
    }
} catch {
    Write-Log "CIM startup lookup skipped or failed: $_"
}

function Is-PidRunning {
    param($ProcessId)
    if (-not $ProcessId) { return $false }
    return (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) -ne $null
}

function Start-Sensor {
    param([string]$scriptPath, [string]$extraArgs = "", [switch]$NoHeadless)
    if ($NoHeadless) {
        $args = $extraArgs.Trim()
    } else {
        $args = "--headless $extraArgs".Trim()
    }
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
Write-Log "Monitoring: tinysa_fusion_bridge.py | ir_bridge.py | rf_camera_bridge.py"
if ($EnablePhoneBridge) {
    Write-Log "Phone bridge requested on ${PhoneHost}:${PhonePort} allow-source=${PhoneAllowSource}"
}
Write-Log "Check interval: ${CheckInterval}s"

while ($true) {
    $now = Get-Date
    # ── Check TinySA Fusion bridge ───────────────────────────────────────────
    if ($TinySACooldownUntil -and $now -lt $TinySACooldownUntil) {
        # Cooldown active.
    } elseif (-not (Is-PidRunning $TinySAPid)) {
        if ($TinySACooldownUntil -and $now -ge $TinySACooldownUntil) {
            Write-Log "TinySA cooldown ended. Trying bridge again."
            $TinySACooldownUntil = $null
            $TinySAFailures = 0
        }
        $TinySAFailures += 1
        if ($TinySAFailures -gt $MaxRestartFailures) {
            $TinySACooldownUntil = $now.AddSeconds($RestartCooldownSeconds)
            $until = $TinySACooldownUntil.ToString("HH:mm:ss")
            Write-Log "PAUSE: tinysa_fusion_bridge.py failed $MaxRestartFailures times. Cooling down until $until to avoid CPU/port churn."
        } else {
            Write-Log "WARNING: tinysa_fusion_bridge.py is NOT running. Restarting... (attempt $TinySAFailures/$MaxRestartFailures)"
            $TinySAPid = Start-Sensor $TinySAScript "--port $TinySAPort --discord-channel 1513582425446289658"
        }
    } else {
        $TinySAFailures = 0
        $TinySACooldownUntil = $null
    }

    # ── Check IR bridge (DISABLED by default - causes repeated camera/mic permission sounds from hidden background process) ─
    # if (-not (Is-PidRunning $IRPid)) {
    #     Write-Log "WARNING: ir_bridge.py is NOT running. Restarting..."
    #     $IRPid = Start-Sensor $IRScript
    # }

    # ── Check RF Camera bridge (DISABLED by default - causes repeated camera permission sounds/UAC prompts from hidden process) ─
    # if (-not (Is-PidRunning $RFCamPid)) {
    #     Write-Log "WARNING: rf_camera_bridge.py is NOT running. Restarting..."
    #     $RFCamPid = Start-Sensor $RFScript "--interval 5"
    # }

    # Optional phone sensor bridge. LAN mode requires a bearer token.
    # This provides real-time phone sensory data (location, accelerometer, battery, barometer, light, etc.)
    # directly into KAI's lattice for protection, context, and future cross-device adaptability
    # (robot bodies, smart glasses, full-dive suits, wearables, etc.).
    if ($EnablePhoneBridge -and -not (Is-PidRunning $PhonePid)) {
        if (($PhoneHost -ne "127.0.0.1") -and ($PhoneHost -ne "localhost") -and (-not $PhoneToken)) {
            Write-Log "WARNING: phone_sensor_bridge.py not started. LAN bind requires KAI_PHONE_SENSOR_TOKEN or -PhoneToken."
        } else {
            if ($PhoneToken) {
                $env:KAI_PHONE_SENSOR_TOKEN = $PhoneToken
            }
            # Kill any stale listeners on the phone port first to prevent duplicate bindings (8787).
            Write-Log "Ensuring no duplicate phone sensor port 8787 before (re)start..."
            powershell -Command "& { netstat -ano | findstr \":8787\" | ForEach-Object { $id = ($_ -split '\s+')[-1]; if($id -match '^\d+$'){ taskkill /F /PID $id 2>$null } } }" | Out-Null

            Write-Log "WARNING: phone_sensor_bridge.py is NOT running. Restarting..."
            $PhonePid = Start-Sensor $PhoneScript "--host $PhoneHost --port $PhonePort --allow-source $PhoneAllowSource" -NoHeadless
        }
    }

    Start-Sleep -Seconds $CheckInterval
}
