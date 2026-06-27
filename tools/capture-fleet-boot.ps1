# Canonical fleet boot capture - UTF-8 Tee-Object logs to SCRATCH (plan filenames).
# Run1 stops the fleet GRACEFULLY (never Stop-Job — that orphans children as 4294967295).
param(
    [string]$ScratchDir = $env:FLEET_BOOT_SCRATCH,
    [int]$BootTimeoutSec = 300
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

if (-not $ScratchDir) {
    $ScratchDir = 'C:\Users\revry\AppData\Local\Temp\grok-goal-d07e950bed3b\implementer'
}
New-Item -ItemType Directory -Force -Path $ScratchDir | Out-Null

$Root = Split-Path $PSScriptRoot -Parent
$OracleRoot = Join-Path $Root 'tools\oracle-discord'
Set-Location $Root
. (Join-Path $OracleRoot 'shared\fleet-health.ps1')

function Stop-FleetGraceful {
    # 1) Stop ecosystem manager (stops respawn loop)
    $mgrPath = Join-Path $OracleRoot 'state\ecosystem-manager.json'
    if (Test-Path $mgrPath) {
        try {
            $mgr = Get-Content $mgrPath -Raw | ConvertFrom-Json
            if ($mgr.managerPid) {
                Stop-Process -Id $mgr.managerPid -Force -ErrorAction SilentlyContinue
            }
        } catch {}
    }
    Start-Sleep -Seconds 1
    # 2) Stop orphaned fleet node processes (filtered CIM — full Win32_Process scan hangs)
    $pRoot = $OracleRoot.Replace('\', '\\')
    $fleetRe = 'oracle-discord|index\.mjs|run-oracle-discord|ecosystem-manager|start-bot|bots/|command-center-server|oracle-gateway'
    foreach ($procName in @('node.exe', 'pwsh.exe', 'powershell.exe')) {
        $existing = Get-CimInstance Win32_Process -Filter ("Name='$procName'") -ErrorAction SilentlyContinue |
            Where-Object {
                ($_.CommandLine -match $fleetRe) -or ($_.CommandLine -match $pRoot)
            }
        foreach ($proc in $existing) {
            if ($proc.ProcessId -eq $PID) { continue }
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
    # 3) Wait for dashboard + IPC ports to clear (engine :3334 stays up)
    $ports = @(3001, 3401, 3402, 3403, 3404, 3405, 3406, 3410, 3420)
    for ($i = 0; $i -lt 45; $i++) {
        $busy = $false
        foreach ($p in $ports) {
            if (netstat -ano | Select-String ":$p\s.*LISTENING") { $busy = $true; break }
        }
        if (-not $busy) { break }
        Start-Sleep -Seconds 1
    }
    # 4) Stop stray Start-KAI / boot-helper launchers (overlap kills fleet)
    foreach ($procName in @('powershell.exe', 'pwsh.exe', 'cmd.exe')) {
        Get-CimInstance Win32_Process -Filter ("Name='$procName'") -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -match 'boot-helper|Start-KAI|KAI-Start\.bat' -and $_.ProcessId -ne $PID } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    }
    # 5) Stop supervisor first (it respawns kai.exe if we only kill the engine)
    for ($i = 0; $i -lt 60; $i++) {
        Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -like '*kai_supervisor*' } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Stop-Process -Name kai -Force -ErrorAction SilentlyContinue
        $kaiGone = -not (Get-Process -Name kai -ErrorAction SilentlyContinue)
        $engDown = -not (Test-FleetEngineReady)
        if ($engDown -and $kaiGone) { break }
        Start-Sleep -Seconds 1
    }
    $engineDown = (-not (Test-FleetEngineReady)) -and (-not (Get-Process -Name kai -ErrorAction SilentlyContinue))
    $nodes = @(Get-Process node -EA SilentlyContinue).Count
    # Rotate ecosystem.log so classifier reads only the next boot window (no historical ghosts).
    $ecoLog = Join-Path $OracleRoot 'logs\ecosystem.log'
    if (Test-Path $ecoLog) {
        $bak = Join-Path $OracleRoot ('logs\ecosystem.log.' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.bak')
        Move-Item $ecoLog $bak -Force
        New-Item -ItemType File -Path $ecoLog -Force | Out-Null
        Write-Host ('[capture-fleet-boot] Rotated ecosystem.log -> ' + (Split-Path $bak -Leaf))
    }
    Write-Host ('[capture-fleet-boot] Fleet stop clean: fleet_ports_clear nodes_remaining=' + $nodes + ' engine_stopped=' + $engineDown)
    return $engineDown
}

function Get-EcoBootLine([string]$ecoLog) {
    $hit = Select-String -Path $ecoLog -Pattern '\[Ecosystem/BOOT\]' -EA SilentlyContinue | Select-Object -Last 1
    if ($hit) { return $hit.LineNumber }
    return 0
}

function Get-ExpectedFleetBuild() {
    $cargo = Join-Path $Root 'Cargo.toml'
    if (-not (Test-Path $cargo)) { return 'v0.0.0' }
    $hit = Select-String -Path $cargo -Pattern '^version\s*=\s*"([^"]+)"' | Select-Object -First 1
    if ($hit) { return 'v' + $hit.Matches[0].Groups[1].Value }
    return 'v0.0.0'
}

function Test-BootReady([string]$text, [string]$fleetBuild) {
    if (-not ($text -match '\[Ecosystem/BOOT\]')) { return $false }
    if (-not ($text -match '\[Leo/Voice\] Successfully anchored')) { return $false }
    if (-not ($text -match "\[Leo/Ready\] FLEET_BUILD=$fleetBuild")) { return $false }
    if (-not ($text -match "\[Groq/Ready\] FLEET_BUILD=$fleetBuild")) { return $false }
    if (-not ($text -match "\[Analyst/Ready\] FLEET_BUILD=$fleetBuild")) { return $false }
    return $true
}

function Wait-BootMarker([string]$logPath, [int]$timeoutSec, [int]$bootLineBefore = 0) {
    $ecoLog = Join-Path $OracleRoot 'logs\ecosystem.log'
    $fleetBuild = Get-ExpectedFleetBuild
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path $ecoLog) {
            $tail = Get-Content $ecoLog -Tail 800 -EA SilentlyContinue
            $tailText = $tail -join "`n"
            if (Test-BootReady $tailText $fleetBuild) { return $true }
        }
        Start-Sleep -Seconds 2
    }
    return $false
}

function Copy-EcoBootArtifact([string]$dest) {
    $ecoLog = Join-Path $OracleRoot 'logs\ecosystem.log'
    if (-not (Test-Path $ecoLog)) { throw 'ecosystem.log missing after boot' }
    Copy-Item $ecoLog $dest -Force
}

function Assert-BootLog([string]$logPath, [string]$label, [int]$bootLineBefore = 0) {
    . (Join-Path $OracleRoot 'shared\fleet-log-classifier.ps1')
    if (-not (Test-Path $logPath)) { throw "$label log missing: $logPath" }
    $size = (Get-Item $logPath).Length
    if ($size -lt 256) { throw ($label + ' log too small (' + $size + 'B < 256B): ' + $logPath) }
    $text = Get-Content $logPath -Raw -Encoding UTF8
    $anchored = ($text -match '\[Leo/Voice\] Successfully anchored')
    if (-not $anchored) {
        throw "$label missing [Leo/Voice] Successfully anchored"
    }
    $logLines = @(Get-Content $logPath -Encoding UTF8 | ForEach-Object { [PSCustomObject]@{ Line = $_; LineNumber = 0 } })
    $m = Measure-FleetLogClassification $logLines
    if ($m.forbidden_boot_count -gt 0) {
        throw ($label + ' forbidden_boot_count=' + $m.forbidden_boot_count + ' (Engine already serving - Stop-FleetGraceful missed kai.exe)')
    }
    if ($m.fatal_count -gt 0) { throw ($label + ' fatal_count=' + $m.fatal_count) }
    $forbidden = @(
        'Engine already serving',
        '\[2/4\] Engine already serving',
        '\[Groq/Voice\] Joining',
        '\[Groq/Voice\] Successfully anchored',
        '\[Groq\].*\[VoiceManager\] Bootstrapping',
        '\[GeminiLive\] Session setup: bot=Gemini'
    )
    foreach ($pat in $forbidden) {
        if ($text -match $pat) { throw ($label + ' forbidden pattern in boot artifact: ' + $pat) }
    }
    $cargo = Join-Path $Root 'Cargo.toml'
    if (Test-Path $cargo) {
        $verHit = Select-String -Path $cargo -Pattern '^version\s*=\s*"([^"]+)"' | Select-Object -First 1
        if ($verHit) {
            $ver = 'v' + $verHit.Matches[0].Groups[1].Value
            foreach ($bot in @('Leo', 'Groq')) {
                if ($text -notmatch "\[$bot/Ready\] FLEET_BUILD=$ver") {
                    throw ($label + " missing [$bot/Ready] FLEET_BUILD=$ver in boot artifact")
                }
            }
        }
    }
    Write-Host ('[capture-fleet-boot] ' + $label + ' PASS (' + $size + 'B allowed_boot=' + $m.allowed_boot_count + ')') -ForegroundColor Green
}

function Assert-StartKaiLauncher([string]$logPath, [string]$label) {
    if (-not (Test-Path $logPath)) { throw "$label launcher log missing: $logPath" }
    $text = Get-Content $logPath -Raw -Encoding UTF8
    if ($text -match '\[2/4\] Engine already serving') {
        throw ($label + ' warm-boot detected — engine was not cold before Start-KAI')
    }
    if ($text -notmatch '\[2/4\] Starting KAI engine') {
        throw ($label + ' missing [2/4] Starting KAI engine in Start-KAI launcher log')
    }
    if ($text -notmatch '\[2/4\] Engine READY') {
        throw ($label + ' missing [2/4] Engine READY in Start-KAI launcher log')
    }
    Write-Host ('[capture-fleet-boot] ' + $label + ' launcher engine markers OK') -ForegroundColor Green
}

function Start-FleetBoot([string]$logPath) {
    # Detached Start-KAI — fleet must survive harness exit (boot-helper parent death killed manager).
    $launcherLog = ($logPath -replace '\.log$', '') + '-launcher.log'
    $helper = Join-Path $ScratchDir 'boot-helper.ps1'
    @"
Set-Location '$Root'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
`$launcherLog = '$launcherLog'
if (Test-Path `$launcherLog) { Remove-Item `$launcherLog -Force }
`$startKai = '$(Join-Path $Root 'Start-KAI.ps1')'
`$bootCmd = "Set-Location '$Root'; & `$startKai *>&1 | Tee-Object -FilePath '`$launcherLog'"
`$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
    '-WindowStyle','Minimized','-ExecutionPolicy','Bypass','-NoProfile','-Command',`$bootCmd
) -PassThru
Start-Sleep -Seconds 2
"`n=== DETACHED Start-KAI PID=`$(`$p.Id) $(Get-Date -Format o) ===`n" | Out-File '$logPath' -Encoding utf8
for (`$i = 0; `$i -lt 240; `$i++) {
    if (Test-Path '$(Join-Path $OracleRoot 'logs\ecosystem.log')') {
        `$tail = Get-Content '$(Join-Path $OracleRoot 'logs\ecosystem.log')' -Tail 30 -EA SilentlyContinue
        if (`$tail -match '\[Leo/Voice\] Successfully anchored') { break }
    }
    Start-Sleep -Seconds 2
}
if (Test-Path `$launcherLog) {
    "`n=== Start-KAI LAUNCHER LOG ===" | Add-Content '$logPath' -Encoding utf8
    Get-Content `$launcherLog -Encoding UTF8 -EA SilentlyContinue | Add-Content '$logPath' -Encoding utf8
}
"`n=== ECOSYSTEM LOG TAIL ===" | Add-Content '$logPath' -Encoding utf8
Get-Content '$(Join-Path $OracleRoot 'logs\ecosystem.log')' -Tail 120 -EA SilentlyContinue |
    Add-Content '$logPath' -Encoding utf8
"@ | Set-Content $helper -Encoding utf8
    return Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', $helper) `
        -PassThru -WindowStyle Minimized
}

# Preflight scope
& (Join-Path $Root 'tools\assert-fleet-scope.ps1')
if ($LASTEXITCODE -ne 0) { throw 'assert-fleet-scope failed - clean workspace first' }

$LockPath = Join-Path $OracleRoot 'state\.capture-fleet.lock'
if (Test-Path $LockPath) {
    Write-Host "[capture-fleet-boot] LOCKED - another capture in progress: $LockPath" -ForegroundColor Red
    exit 1
}
New-Item -ItemType File -Force -Path $LockPath -Value $PID | Out-Null
try {

$run1 = Join-Path $ScratchDir 'start-kai-run1.log'
$run2 = Join-Path $ScratchDir 'start-kai-run2.log'
$eco1 = Join-Path $ScratchDir 'eco-boot-run1.log'
$eco2 = Join-Path $ScratchDir 'eco-boot-run2.log'
$launcher = $null
$bootLineRun1 = 0
$bootLineRun2 = 0
$engineStoppedRun1 = $false
$engineStoppedRun2 = $false

foreach ($n in 1, 2) {
    $log = if ($n -eq 1) { $run1 } else { $run2 }
    Write-Host "[capture-fleet-boot] Boot run $n -> $log" -ForegroundColor Cyan
    if (Test-Path $log) { Remove-Item $log -Force }
    $engineDown = Stop-FleetGraceful
    if ($n -eq 1) { $engineStoppedRun1 = $engineDown } else { $engineStoppedRun2 = $engineDown }
    if (-not $engineDown) {
        throw 'Engine still serving on :3334 after Stop-FleetGraceful (supervisor may have respawned kai.exe)'
    }
    Start-Sleep -Seconds 3
    $ecoLog = Join-Path $OracleRoot 'logs\ecosystem.log'
    $bootLineBefore = Get-EcoBootLine $ecoLog
    if ($n -eq 1) { $bootLineRun1 = $bootLineBefore } else { $bootLineRun2 = $bootLineBefore }
    $launcher = Start-FleetBoot $log
    if (-not (Wait-BootMarker $log $BootTimeoutSec $bootLineBefore)) {
        Stop-FleetGraceful
        if ($launcher -and -not $launcher.HasExited) {
            Stop-Process -Id $launcher.Id -Force -ErrorAction SilentlyContinue
        }
        throw "Boot run $n timed out waiting for Leo anchor"
    }
    Assert-StartKaiLauncher $log "run$n"
    $ecoArtifact = if ($n -eq 1) { $eco1 } else { $eco2 }
    Copy-EcoBootArtifact $ecoArtifact
    if ($n -eq 1) {
        # Graceful stop — never Stop-Job (causes 4294967295 respawn storm on all bots).
        Stop-FleetGraceful
        if ($launcher -and -not $launcher.HasExited) {
            Stop-Process -Id $launcher.Id -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 3
    }
}

$ecoLog = Join-Path $OracleRoot 'logs\ecosystem.log'
if (Test-Path $ecoLog) {
    "`n=== ECOSYSTEM LOG TAIL (run2) ===" | Out-File (Join-Path $ScratchDir 'ecosystem-tail.txt') -Encoding utf8
    Get-Content $ecoLog -Tail 120 -Encoding UTF8 | Add-Content (Join-Path $ScratchDir 'ecosystem-tail.txt') -Encoding utf8
    Get-ChildItem (Join-Path $OracleRoot 'logs\bot-*.log') -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 3 | ForEach-Object {
            "`n=== $($_.Name) tail ===" | Add-Content (Join-Path $ScratchDir 'ecosystem-tail.txt') -Encoding utf8
            Get-Content $_.FullName -Tail 40 -Encoding UTF8 | Add-Content (Join-Path $ScratchDir 'ecosystem-tail.txt') -Encoding utf8
        }
}

Assert-BootLog $eco1 'eco-run1' $bootLineRun1
Assert-BootLog $eco2 'eco-run2' $bootLineRun2

& (Join-Path $Root 'tools\post-boot-error-audit.ps1') -Out (Join-Path $ScratchDir 'post-boot-error-audit.txt')
if ($LASTEXITCODE -ne 0) {
    Write-Host '[capture-fleet-boot] WARN post-boot-error-audit reported issues — see post-boot-error-audit.txt' -ForegroundColor Yellow
}

@{
    scratch = $ScratchDir
    run1 = $run1
    run2 = $run2
    eco_boot_run1 = $eco1
    eco_boot_run2 = $eco2
    run1Bytes = (Get-Item $run1).Length
    run2Bytes = (Get-Item $run2).Length
    engine_stopped_before_run1 = $engineStoppedRun1
    engine_stopped_before_run2 = $engineStoppedRun2
    engine_cold_before_each_boot = ($engineStoppedRun1 -and $engineStoppedRun2)
    fleetLeftRunning = $true
    capture_completed_at = (Get-Date -Format o)
    pulse_at_capture_end = (Test-FleetManagerPulse)
    engine_ready_at_capture_end = (Test-FleetEngineReady)
    nodes_at_capture_end = @(Get-Process node -ErrorAction SilentlyContinue).Count
    note = 'run1 stopped after anchor; run2 left running. Each boot requires cold engine ([2/4] Starting KAI engine + Engine READY in start-kai-runN.log). Ollama/supervisor may show already serving.'
} | ConvertTo-Json | Set-Content (Join-Path $ScratchDir 'capture-fleet-boot-result.json') -Encoding utf8

Write-Host "[capture-fleet-boot] DONE - fleet left running; logs in $ScratchDir" -ForegroundColor Green
exit 0
} finally {
    if (Test-Path $LockPath) { Remove-Item $LockPath -Force -ErrorAction SilentlyContinue }
}