<#
================================================================================
  Start-KAI.ps1  -  THE single master launcher for the KAI / Oracle ecosystem.
================================================================================
  This is the ONE way to start everything. It boots each component in strict
  dependency order and GATES each stage on the previous one being actually READY
  (not merely launched), so nothing races a half-up service.

  Boot order:
    0. Environment   - governors + RAM-fix flags, set ONCE so every child inherits them
    1. Ollama (:11434)        - start if down, wait until it serves   (fallback LLM)
    2. KAI engine (:3334)     - start target\release\kai.exe, WAIT for /api/session
                                (the long pole - the brain index can take a while)
    3. Supervisor             - kai_supervisor.py, started ONLY after the engine is
                                up, so it can never race and launch a 2nd engine
    4. Fleet                  - run-oracle-discord.ps1 -NoStartKai  (Oracle, Leo,
                                bots, dashboard). Runs in the foreground and keeps
                                the session alive.

  Usage:
    .\Start-KAI.ps1                 # essentials: Leo + core online, social bots asleep
    .\Start-KAI.ps1 -FullFleet      # boot every bot immediately
  Switches:
    -NoStreamingSave   keep the engine on the old clone autosave (more RAM, proven)
    -NoSupervisor      don't start the RAM-ceiling watchdog
    -NoOllama          skip the Ollama stage entirely
    -CheckOnly         pass-through dry run to the fleet launcher
    -EngineTimeoutSec  how long to wait for the engine to answer (default 300)

  Updated: June 19, 2026 - v9.9.0
================================================================================
#>
param(
    [switch]$FullFleet,
    [switch]$NoStreamingSave,
    [switch]$NoSupervisor,
    [switch]$NoOllama,
    [switch]$NoPipeline,
    [switch]$CheckOnly,
    [int]$EngineTimeoutSec = 300
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$Root = $PSScriptRoot
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Test-Port([int]$Port) {
    try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $Port); $c.Close(); return $true }
    catch { return $false }
}
function Test-EngineHttp {
    try { return ((Invoke-WebRequest "http://127.0.0.1:3334/api/session" -TimeoutSec 3 -UseBasicParsing).StatusCode -eq 200) }
    catch { return $false }
}
function Get-KaiProcs { @(Get-Process -Name kai -ErrorAction SilentlyContinue) }
function Get-SupervisorProc {
    Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*kai_supervisor*' }
}

Write-Host ""
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "  KAI MASTER LAUNCHER  -  single, ordered, gated boot  (v9.9.0)"   -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan

# Stage 0: environment (set ONCE, inherited by engine, supervisor, and fleet)
if (-not $env:RAYON_NUM_THREADS)         { $env:RAYON_NUM_THREADS = "6" }          # cap KAI's Rust threads to physical cores
if (-not $env:OLLAMA_MAX_LOADED_MODELS)  { $env:OLLAMA_MAX_LOADED_MODELS = "2" }
if (-not $env:OLLAMA_NUM_PARALLEL)       { $env:OLLAMA_NUM_PARALLEL = "1" }
if (-not $env:OLLAMA_KEEP_ALIVE)         { $env:OLLAMA_KEEP_ALIVE = "3m" }
if (-not $FullFleet)                     { $env:KAI_FORCE_LIMITED = "1" }          # essentials = overnight RAM guard
# Engine RAM ceiling: AUTO-SIZED to this machine's real RAM (~58% of total) so the
# engine never grows into the OS + fleet + Ollama and forces a swap (swapping is what
# stutters Leo's audio). 32GB -> ~18GB ceiling; 16GB -> ~9GB. Override by setting
# KAI_ENGINE_RSS_RESTART_MB yourself before launch.
if (-not $env:KAI_ENGINE_RSS_RESTART_MB) {
    try {
        $totalMB = [int]((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1MB)
        $ceil = [int]($totalMB * 0.58)
        if ($ceil -lt 8000) { $ceil = 8000 }
        $env:KAI_ENGINE_RSS_RESTART_MB = "$ceil"
        Write-Host "[0/4] Detected $totalMB MB RAM -> engine ceiling $ceil MB (~58%)." -ForegroundColor DarkGray
    } catch {
        $env:KAI_ENGINE_RSS_RESTART_MB = "9000"
    }
}
$env:RUST_BACKTRACE = "1"
if ($NoStreamingSave) {
    $env:KAI_STREAMING_SAVE = "0"
    Write-Host "[0/4] Streaming autosave: OFF - old whole-Universe clone path." -ForegroundColor DarkYellow
} else {
    $env:KAI_STREAMING_SAVE = "1"
    Write-Host "[0/4] Streaming autosave: ON - RAM relief, atomic-safe. Use -NoStreamingSave to revert." -ForegroundColor Green
}
Write-Host "[0/4] Governors set: RAYON=6, Ollama caps, engine RAM ceiling $($env:KAI_ENGINE_RSS_RESTART_MB) MB (auto-sized) - inherited by all children." -ForegroundColor Green

# Stage 1: Ollama
if ($NoOllama) {
    Write-Host "[1/4] Ollama: skipped (-NoOllama)." -ForegroundColor DarkGray
} elseif (Test-Port 11434) {
    Write-Host "[1/4] Ollama already serving on :11434." -ForegroundColor Green
} else {
    if (Get-Command ollama -ErrorAction SilentlyContinue) {
        Write-Host "[1/4] Starting Ollama (ollama serve, throttled)..." -ForegroundColor Yellow
        # Keep local inference from pegging the box: load ONE model at a time, no parallel
        # inference, and UNLOAD models ~30s after idle so they don't sit resident in RAM
        # (Owner: KAI/Ollama spiking CPU + holding GBs of RAM, starving the engine outside 3am).
        $env:OLLAMA_MAX_LOADED_MODELS = '1'
        $env:OLLAMA_NUM_PARALLEL      = '1'
        $env:OLLAMA_KEEP_ALIVE        = '30s'
        $oll = Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden -PassThru
        try { if ($oll) { $oll.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::BelowNormal } } catch {}
        for ($i = 0; $i -lt 30 -and -not (Test-Port 11434); $i++) { Start-Sleep -Seconds 1 }
        if (Test-Port 11434) { Write-Host "[1/4] Ollama up on :11434 (1 model, no-parallel, 30s keep-alive, BelowNormal)." -ForegroundColor Green }
        else { Write-Host "[1/4] Ollama did not answer in 30s - continuing. KAI is native-first; Ollama is only a fallback." -ForegroundColor DarkYellow }
    } else {
        Write-Host "[1/4] Ollama not installed - skipping. KAI answers via native BitNet; Ollama is only a fallback." -ForegroundColor DarkYellow
    }
}

# Stage 2: KAI engine - the long pole. Start the FRESH build, then WAIT for it.
if (Test-EngineHttp) {
    Write-Host "[2/4] Engine already serving on :3334 - not starting a second one." -ForegroundColor Green
} else {
    $kaiExe = Join-Path $Root "target\release\kai.exe"
    if (-not (Test-Path $kaiExe)) {
        throw "[2/4] Engine binary missing at $kaiExe. Build it first:  cargo build --release --bin kai"
    }
    if ((Get-KaiProcs).Count -gt 0) {
        Write-Host "[2/4] A kai.exe is already running but not answering yet - waiting for it to warm up (NOT starting a duplicate)." -ForegroundColor Yellow
    } else {
        $scratch = Join-Path $Root "scratch"; New-Item -ItemType Directory -Force -Path $scratch | Out-Null
        $stdout  = Join-Path $scratch "oracle-discord-kai.out.log"
        $stderr  = Join-Path $scratch "oracle-discord-kai.err.log"
        if ((Test-Path $stderr) -and (Get-Item $stderr).Length -gt 0) {
            Copy-Item $stderr (Join-Path $scratch ("kai-crash-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".err.log")) -ErrorAction SilentlyContinue
        }
        Write-Host "[2/4] Starting KAI engine (target\release\kai.exe --oracle)..." -ForegroundColor Yellow
        # LAUNCH IN ITS OWN CONSOLE — NOT hidden+redirected. The old
        # '-WindowStyle Hidden -RedirectStandardOutput/-RedirectStandardError' combo
        # SILENTLY KILLED the engine right after 'Publishing lattice warehouse' (the
        # redirected-pipe + hidden-window combination drops the long-running Rust
        # process, so :3334 never came up and the whole stack stayed down). Run with
        # a real console (like the supervisor does) and it boots and serves fine. The
        # engine prints to its own minimized window; that IS its log.
        $usePsLog = ($env:KAI_ENGINE_PSLOG -eq '1')   # opt-in: old redirected-log behaviour
        if ($usePsLog) {
            Start-Process -FilePath $kaiExe -ArgumentList "--oracle" -WorkingDirectory $Root -WindowStyle Hidden `
                -RedirectStandardOutput $stdout -RedirectStandardError $stderr | Out-Null
        } else {
            Start-Process -FilePath $kaiExe -ArgumentList "--oracle" -WorkingDirectory $Root -WindowStyle Minimized | Out-Null
        }
    }
    Write-Host ("[2/4] Waiting up to {0}s for the engine to answer on :3334 (the brain index can take a while)" -f $EngineTimeoutSec) -NoNewline
    $ready = $false
    for ($i = 0; $i -lt $EngineTimeoutSec; $i++) {
        if (Test-EngineHttp) { $ready = $true; break }
        if ($i % 5 -eq 0) { Write-Host "." -NoNewline }
        Start-Sleep -Seconds 1
    }
    Write-Host ""
    if ($ready) { Write-Host "[2/4] Engine READY on :3334." -ForegroundColor Green }
    else { throw "[2/4] Engine did not become reachable in $EngineTimeoutSec s. Check scratch\oracle-discord-kai.err.log" }
}

# Stage 3: Supervisor - only NOW (engine confirmed up, so no 2nd-engine race).
if ($NoSupervisor) {
    Write-Host "[3/4] Supervisor: skipped (-NoSupervisor)." -ForegroundColor DarkGray
} elseif (Get-SupervisorProc) {
    Write-Host "[3/4] Supervisor already running." -ForegroundColor Green
} else {
    Write-Host "[3/4] Starting the RAM-ceiling watchdog (kai_supervisor.py)..." -ForegroundColor Yellow
    Start-Process -FilePath "python" -ArgumentList "`"$Root\kai_supervisor.py`"" -WindowStyle Minimized | Out-Null
    Write-Host "[3/4] Supervisor up - recycles the engine above 9GB and self-heals dead services." -ForegroundColor Green
}

# Stage 3.5: Overnight learning pipeline keeper. Runs overnight_pipeline.py, which fires
# KAI's 3am ingest -> weave -> train and writes the lockfile + completion flag the Oracle
# overnight orchestrator coordinates with. Start-KAI must launch it so the 3am cycle can
# actually trigger. Stays hidden + BelowNormal so it never fights the live fleet.
if ($NoPipeline) {
    Write-Host "[3.5/4] Overnight pipeline keeper: skipped (-NoPipeline)." -ForegroundColor DarkGray
} else {
    $pipeKeeper = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*keep_pipeline_alive*' -or $_.CommandLine -like '*overnight_pipeline*' }
    if ($pipeKeeper) {
        Write-Host "[3.5/4] Overnight pipeline keeper already running." -ForegroundColor Green
    } else {
        Write-Host "[3.5/4] Starting overnight pipeline keeper (keep_pipeline_alive.ps1) for KAI's 3am ingest/weave/train..." -ForegroundColor Yellow
        Start-Process -FilePath "powershell" -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File","`"$Root\keep_pipeline_alive.ps1`"" -WindowStyle Hidden | Out-Null
        Write-Host "[3.5/4] Pipeline keeper up (hidden) - overnight_pipeline.py will trigger at 3am." -ForegroundColor Green
    }
}

# Stage 4: Fleet - engine is up, so delegate with -NoStartKai (this BLOCKS, by design).
. (Join-Path $Root 'tools\oracle-discord\shared\fleet-health.ps1')
foreach ($harnessLock in @(
    (Join-Path $Root 'tools\oracle-discord\state\.verify-fleet.lock'),
    (Join-Path $Root 'tools\oracle-discord\state\.capture-fleet.lock')
)) {
    if ((Test-Path $harnessLock) -and (Test-FleetManagerPulse)) {
        Write-Host "[4/4] Fleet harness active and fleet healthy ($harnessLock) - skipping duplicate launch." -ForegroundColor Yellow
        return
    }
}
Write-Host "[4/4] Starting the fleet (Oracle, Leo, bots, dashboard) - this window stays in the foreground." -ForegroundColor Yellow
Write-Host ""
$fleetArgs = @{ NoStartKai = $true }
if ($FullFleet) { $fleetArgs['FullFleet'] = $true }
if ($CheckOnly) { $fleetArgs['CheckOnly'] = $true }
& (Join-Path $Root "run-oracle-discord.ps1") @fleetArgs
