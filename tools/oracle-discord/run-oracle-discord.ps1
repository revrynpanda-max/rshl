param(
    [switch]$CheckOnly,
    [switch]$NoStartKai,
    [Parameter(Mandatory=$false)]
    [switch]$ConfigureMain,
    [Parameter(Mandatory=$false)]
    [switch]$ConfigureSpeakers,
    [switch]$ConfigureVoice,
    [switch]$FullFleet,
    [switch]$NoSensors
)

# -- BOOT MODE -----------------------------------------------------------------
#  Default (no flag): ESSENTIALS MODE - Leo + core (Oracle, KAI, Dashboard)
#    and helpers boot online; the social bots (Gemini, Claudey, X, Groq) start
#    ASLEEP to keep CPU/GPU light. Wake them anytime via Oracle in Discord
#    ("wake groq", "wake up all") - the engine reads ORACLE_START_SLEEP_BOTS.
#  -FullFleet : boot EVERY agent immediately (no sleep list).
if ($FullFleet) {
    Remove-Item "Env:ORACLE_START_SLEEP_BOTS" -ErrorAction SilentlyContinue
    Write-Host "[Power] FULL FLEET mode - every agent boots online." -ForegroundColor Yellow
} else {
    # NIGHT / ESSENTIALS: only Leo + core (Oracle, KAI, Dashboard) boot online.
    # The social bots start ASLEEP (this was previously set to "" by mistake, so
    # they booted online anyway). Wake any of them via Oracle in Discord.
    # Groq stays AWAKE — he owns the radio/DJ room. With Groq asleep the radio was
    # unowned and Leo (always-on voice) wrongly filled the vacuum and "ran" it. The
    # other social bots still start asleep for resources; wake them via Oracle.
    $env:ORACLE_START_SLEEP_BOTS = "Gemini,Claudey,X"
    # Overnight-safe: force the RAM-protective governor baselines so KAI backs off
    # learning/ingest early and the machine never reaches a bad point while you sleep.
    $env:KAI_FORCE_LIMITED = "1"
    Write-Host "[Power] Essentials mode: Leo + Oracle + KAI core + Groq (radio DJ) online; Gemini/Claudey/X start ASLEEP." -ForegroundColor Yellow
    Write-Host "[Power] Overnight RAM guard ON (KAI_FORCE_LIMITED=1) - learning backs off early to protect the machine." -ForegroundColor DarkYellow
    Write-Host "[Power] Wake them via Oracle ('wake groq' / 'wake up all'), or use -FullFleet to boot everyone." -ForegroundColor DarkYellow
}

# Force UTF-8 so Unicode characters display correctly in PowerShell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# -- CPU GOVERNOR --------------------------------------------------------------
# Ryzen 5 7600 = 6 cores / 12 threads. Cap KAI's Rust (rayon) global thread pool
# to the 6 physical cores so it can't saturate all 12 and freeze the machine.
# Leaves the SMT threads free for Leo's voice, the LLMs, and the OS.
if (-not $env:RAYON_NUM_THREADS) { $env:RAYON_NUM_THREADS = "6" }

# -- OLLAMA RAM GOVERNOR -------------------------------------------------------
# The "llama server" RAM you've seen pile up = ollama holding several Sovereign
# models in memory at once (each is GBs) + large parallel KV caches. These caps
# keep it lean: at most 2 models resident, 1 request at a time, and idle models
# unload after 3 min so RAM frees between uses. NOTE: ollama runs as its own
# background server, so for these to truly bite you must ALSO set them for the
# ollama service once (see the setx commands I gave you) and restart ollama.
if (-not $env:OLLAMA_MAX_LOADED_MODELS) { $env:OLLAMA_MAX_LOADED_MODELS = "2" }
if (-not $env:OLLAMA_NUM_PARALLEL)      { $env:OLLAMA_NUM_PARALLEL = "1" }
if (-not $env:OLLAMA_KEEP_ALIVE)        { $env:OLLAMA_KEEP_ALIVE = "3m" }

# Continue globally: child bot stderr must never terminate this launcher (see run-ecosystem.ps1).
# Bootstrap steps below use explicit exit/throw on failure instead of relying on Stop.
$ErrorActionPreference = "Continue"
$ConfigPath = Join-Path $PSScriptRoot ".oracle-discord.local.xml"
$ParticipantTokenNames = @(
    @{ Name = "KAI";          Env = "ORACLE_DISCORD_TOKEN_KAI" },
    @{ Name = "Leo";          Env = "ORACLE_DISCORD_TOKEN_LEO" },
    @{ Name = "Analyst";      Env = "ORACLE_DISCORD_TOKEN_ANALYST" },
    @{ Name = "Researcher";   Env = "ORACLE_DISCORD_TOKEN_RESEARCHER" },
    @{ Name = "Groq";         Env = "ORACLE_DISCORD_TOKEN_GROQ" },
    @{ Name = "X";            Env = "ORACLE_DISCORD_TOKEN_X" },
    @{ Name = "Gemini";       Env = "ORACLE_DISCORD_TOKEN_GEMINI" },
    @{ Name = "GPT";          Env = "ORACLE_DISCORD_TOKEN_GPT" },
    @{ Name = "Oracle Coder"; Env = "ORACLE_DISCORD_TOKEN_ORACLE_CODER" },
    @{ Name = "Claudey";      Env = "ORACLE_DISCORD_TOKEN_CLAUDEY" }
)

function ConvertFrom-SecureStringPlain {
    param([System.Security.SecureString]$Secure)
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try {
        [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
}

function Import-DiscordConfig {
    if (-not (Test-Path $ConfigPath)) {
        return
    }
    try {
        $config = Import-Clixml -Path $ConfigPath
        if (-not $config.Token -or $ConfigureMain) {
            $secure = Read-Host "Enter MAIN Oracle Discord Bot Token" -AsSecureString
            $config.Token = $secure
            Save-DiscordConfig $config
        }
        if ($config.Token) {
            $env:ORACLE_DISCORD_TOKEN = (ConvertFrom-SecureStringPlain $config.Token).Trim()
        }
        if ($config.AllowedUserId) {
            $env:ORACLE_DISCORD_ALLOWED_USER_ID = [string]$config.AllowedUserId
        }
        if ($config.AllowedChannelId) {
            $env:ORACLE_DISCORD_ALLOWED_CHANNEL_ID = [string]$config.AllowedChannelId
        }
        if ($config.PublicChatChannelId) {
            $env:ORACLE_DISCORD_PUBLIC_CHAT_CHANNEL_ID = [string]$config.PublicChatChannelId
        }
        if ($config.LeoVoiceChannelId) {
            $env:ORACLE_DISCORD_LEO_VOICE_CHANNEL_ID = [string]$config.LeoVoiceChannelId
        }
        if ($config.ElevenLabsLeoVoiceId) {
            $env:ELEVENLABS_LEO_VOICE_ID = [string]$config.ElevenLabsLeoVoiceId
        }
        if ($config.ElevenLabsApiKey) {
            $env:ELEVENLABS_API_KEY = ConvertFrom-SecureStringPlain $config.ElevenLabsApiKey
        }
        if ($config.OpenAiApiKey) {
            $env:OPENAI_API_KEY = ConvertFrom-SecureStringPlain $config.OpenAiApiKey
        }
        if ($config.ParticipantTokens) {
            foreach ($participant in $ParticipantTokenNames) {
                $envName = $participant.Env
                # .env values take priority - only use saved XML if env var is not already set
                $alreadySet = (Get-Item "Env:$envName" -ErrorAction SilentlyContinue).Value
                if ($alreadySet) {
                    Write-Host "  $envName already set from .env - skipping saved config."
                    continue
                }
                $secure = $config.ParticipantTokens.$envName
                if ($secure) {
                    $val = (ConvertFrom-SecureStringPlain $secure).Trim()
                    Set-Item "Env:$envName" $val
                }
            }
        }
        Write-Host "Loaded saved Discord gateway config."
    } catch {
        Write-Warning "Saved Discord config could not be loaded. You will be asked again. $($_.Exception.Message)"
    }
}

function Save-DiscordConfig {
    if (-not $env:ORACLE_DISCORD_TOKEN -or -not $env:ORACLE_DISCORD_ALLOWED_USER_ID) {
        return
    }
    $secureToken = ConvertTo-SecureString -String $env:ORACLE_DISCORD_TOKEN -AsPlainText -Force
    $participantTokens = [ordered]@{}
    foreach ($participant in $ParticipantTokenNames) {
        $envName = $participant.Env
        $value = (Get-Item "Env:$envName" -ErrorAction SilentlyContinue).Value
        if ($value) {
            $participantTokens[$envName] = ConvertTo-SecureString -String $value -AsPlainText -Force
        }
    }
    [pscustomobject]@{
        Token = $secureToken
        AllowedUserId = $env:ORACLE_DISCORD_ALLOWED_USER_ID
        AllowedChannelId = $env:ORACLE_DISCORD_ALLOWED_CHANNEL_ID
        PublicChatChannelId = $env:ORACLE_DISCORD_PUBLIC_CHAT_CHANNEL_ID
        LeoVoiceChannelId = $env:ORACLE_DISCORD_LEO_VOICE_CHANNEL_ID
        ElevenLabsLeoVoiceId = $env:ELEVENLABS_LEO_VOICE_ID
        ElevenLabsApiKey = if ($env:ELEVENLABS_API_KEY) { ConvertTo-SecureString -String $env:ELEVENLABS_API_KEY -AsPlainText -Force } else { $null }
        OpenAiApiKey = if ($env:OPENAI_API_KEY) { ConvertTo-SecureString -String $env:OPENAI_API_KEY -AsPlainText -Force } else { $null }
        ParticipantTokens = [pscustomobject]$participantTokens
    } | Export-Clixml -Path $ConfigPath
    Write-Host "Saved Discord gateway config for this Windows user."
}

function EnsureParticipantTokens {
    if (-not $ConfigureSpeakers) {
        return
    }
    Write-Host ""
    Write-Host "Optional speaker bot tokens. Press Enter to skip any speaker."
    Write-Host "Use bot tokens here, not application IDs."
    foreach ($participant in $ParticipantTokenNames) {
        $envName = $participant.Env
        $name = $participant.Name
        $existing = (Get-Item "Env:$envName" -ErrorAction SilentlyContinue).Value
        if ($existing) {
            $replace = Read-Host "$name token already saved. Replace it? (y/N)"
            if ($replace.Trim().ToLowerInvariant() -ne "y") {
                continue
            }
        }
        $secure = Read-Host "$envName" -AsSecureString
        $plain = ConvertFrom-SecureStringPlain $secure
        if (-not [string]::IsNullOrWhiteSpace($plain)) {
            Set-Item "Env:$envName" $plain.Trim()
        }
    }
}

function Clear-DiscordEnvConfig {
    $names = @(
        "ORACLE_DISCORD_TOKEN",
        "ORACLE_DISCORD_ALLOWED_USER_ID",
        "ORACLE_DISCORD_ALLOWED_CHANNEL_ID",
        "ORACLE_DISCORD_PUBLIC_CHAT_CHANNEL_ID",
        "ORACLE_DISCORD_LEO_VOICE_CHANNEL_ID",
        "ELEVENLABS_LEO_VOICE_ID",
        "ELEVENLABS_API_KEY"
    )
    foreach ($participant in $ParticipantTokenNames) {
        $names += $participant.Env
    }
    foreach ($name in $names) {
        Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    }
}

function Ensure-DiscordConfig {
    Import-DiscordConfig
    if (-not $env:ORACLE_DISCORD_TOKEN) {
        Write-Host "Paste your Discord bot token. It will not be echoed or saved."
        $env:ORACLE_DISCORD_TOKEN = (ConvertFrom-SecureStringPlain (Read-Host "ORACLE_DISCORD_TOKEN" -AsSecureString)).Trim()
    }
    if (-not $env:ORACLE_DISCORD_ALLOWED_USER_ID) {
        Write-Host "Discord needs your numeric User ID, not your username."
        Write-Host "Enable Developer Mode, right-click your profile, then Copy User ID."
        $env:ORACLE_DISCORD_ALLOWED_USER_ID = (Read-Host "ORACLE_DISCORD_ALLOWED_USER_ID").Trim()
    }
    if (-not $env:ORACLE_DISCORD_ALLOWED_CHANNEL_ID) {
        Write-Host "Optional: paste a numeric Channel ID to lock the bot to one channel, or press Enter to skip."
        $channel = Read-Host "ORACLE_DISCORD_ALLOWED_CHANNEL_ID"
        if (-not [string]::IsNullOrWhiteSpace($channel)) {
            $env:ORACLE_DISCORD_ALLOWED_CHANNEL_ID = $channel.Trim()
        }
    }
    if (-not $env:ORACLE_DISCORD_PUBLIC_CHAT_CHANNEL_ID) {
        $env:ORACLE_DISCORD_PUBLIC_CHAT_CHANNEL_ID = "1499108697631232090"
        Write-Host "Public chat channel set to $env:ORACLE_DISCORD_PUBLIC_CHAT_CHANNEL_ID"
    }
    if (-not $env:ORACLE_DISCORD_LEO_VOICE_CHANNEL_ID) {
        $env:ORACLE_DISCORD_LEO_VOICE_CHANNEL_ID = "1489796367466500129"
        Write-Host "Leo voice channel set to $env:ORACLE_DISCORD_LEO_VOICE_CHANNEL_ID"
    }
    if (-not $env:ELEVENLABS_LEO_VOICE_ID) {
        $env:ELEVENLABS_LEO_VOICE_ID = "NoFvXLmt0kcLW6bQBQ06"
        Write-Host "Leo ElevenLabs voice ID set to $env:ELEVENLABS_LEO_VOICE_ID"
    }
    if ($ConfigureVoice) {
        # OpenAI API key (used for TTS fallback when ElevenLabs is unavailable)
        $replaceOpenAiKey = "y"
        if ($env:OPENAI_API_KEY) {
            $replaceOpenAiKey = Read-Host "OpenAI API key already saved. Replace it? (y/N)"
        }
        if (-not $env:OPENAI_API_KEY -or $replaceOpenAiKey.Trim().ToLowerInvariant() -eq "y") {
            Write-Host "Paste your OpenAI API key (used for Leo TTS fallback). It will not be echoed."
            $env:OPENAI_API_KEY = (ConvertFrom-SecureStringPlain (Read-Host "OPENAI_API_KEY" -AsSecureString)).Trim()
        }
        # ElevenLabs (optional - used for higher-quality voice if subscription active)
        $replaceVoiceKey = "y"
        if ($env:ELEVENLABS_API_KEY) {
            $replaceVoiceKey = Read-Host "ElevenLabs API key already saved. Replace it? (y/N)"
        }
        if (-not $env:ELEVENLABS_API_KEY -or $replaceVoiceKey.Trim().ToLowerInvariant() -eq "y") {
            Write-Host "Paste your ElevenLabs API key for Leo voice (optional, press Enter to skip)."
            $elKey = (ConvertFrom-SecureStringPlain (Read-Host "ELEVENLABS_API_KEY" -AsSecureString)).Trim()
            if ($elKey) { $env:ELEVENLABS_API_KEY = $elKey }
        }
        $voiceChannel = Read-Host "ORACLE_DISCORD_LEO_VOICE_CHANNEL_ID [$env:ORACLE_DISCORD_LEO_VOICE_CHANNEL_ID]"
        if (-not [string]::IsNullOrWhiteSpace($voiceChannel)) {
            $env:ORACLE_DISCORD_LEO_VOICE_CHANNEL_ID = $voiceChannel.Trim()
        }
        $voiceId = Read-Host "ELEVENLABS_LEO_VOICE_ID [$env:ELEVENLABS_LEO_VOICE_ID]"
        if (-not [string]::IsNullOrWhiteSpace($voiceId)) {
            $env:ELEVENLABS_LEO_VOICE_ID = $voiceId.Trim()
        }
    }
    EnsureParticipantTokens
    Save-DiscordConfig
}

function Test-OracleReachable {
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:3334/api/session" -Method Get -TimeoutSec 2 | Out-Null
        $true
    } catch {
        $false
    }
}

function Test-JarvisReachable {
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:8080/" -Method Get -TimeoutSec 2 | Out-Null
        $true
    } catch {
        $false
    }
}

function Start-KaiOracle {
    param([string]$RepoRoot)
    $kaiExe = Join-Path $RepoRoot "target\release\kai.exe"
    if (-not (Test-Path $kaiExe)) {
        throw "KAI release binary not found at $kaiExe. Run: cargo build --release --bin kai"
    }

    $scratch = Join-Path $RepoRoot "scratch"
    New-Item -ItemType Directory -Force -Path $scratch | Out-Null
    $stdout = Join-Path $scratch "oracle-discord-kai.out.log"
    $stderr = Join-Path $scratch "oracle-discord-kai.err.log"

    # Preserve the previous run's stderr before it gets overwritten -- a Rust
    # abort (0xc0000409) prints "thread '...' panicked at ..." or "memory
    # allocation of N bytes failed" here. Archiving it leaves a readable
    # post-mortem after a crash instead of losing it on the next launch.
    if ((Test-Path $stderr) -and (Get-Item $stderr).Length -gt 0) {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        Copy-Item $stderr (Join-Path $scratch "kai-crash-$stamp.err.log") -ErrorAction SilentlyContinue
    }
    # Rust backtrace on panic -> the .err.log names the exact file:line that aborted.
    $env:RUST_BACKTRACE = "1"

    Write-Host "Oracle is not reachable. Starting KAI in the background..."
    Start-Process -FilePath $kaiExe `
        -ArgumentList "--oracle" `
        -WorkingDirectory $RepoRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr | Out-Null

    for ($i = 0; $i -lt 60; $i++) {
        if (Test-OracleReachable) {
            Write-Host "Oracle is reachable at http://127.0.0.1:3334"
            return
        }
        Start-Sleep -Milliseconds 500
    }

    throw "KAI started, but Oracle did not become reachable. Check $stderr"
}

function Start-OpenJarvis {
    param([string]$JarvisDir)

    if (-not (Test-Path $JarvisDir)) {
        Write-Host "[OpenJarvis] Directory not found at $JarvisDir - skipping."
        return
    }

    # Already running - nothing to do
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:8080/" -Method Get -TimeoutSec 2 | Out-Null
        Write-Host "[OpenJarvis] Already running at http://127.0.0.1:8080"
        return
    } catch {}

    Write-Host "[OpenJarvis] Launching in background (non-blocking)..."

    $scratch = Join-Path (Split-Path $JarvisDir -Parent) "scratch"
    New-Item -ItemType Directory -Force -Path $scratch | Out-Null
    $logOut = Join-Path $scratch "openjarvis.out.log"
    $logErr = Join-Path $scratch "openjarvis.err.log"

    $env:OPENJARVIS_CONFIG = Join-Path $JarvisDir "configs\openjarvis\config.toml"
    $uvPath = (Get-Command uv -ErrorAction SilentlyContinue).Source
    if (-not $uvPath) { $uvPath = "$env:USERPROFILE\.local\bin\uv.exe" }
    if (-not (Test-Path $uvPath)) { $uvPath = "C:\Users\$env:USERNAME\.local\bin\uv.exe" }

    $defaultConfigDir = Join-Path $env:USERPROFILE ".openjarvis"
    New-Item -ItemType Directory -Force -Path $defaultConfigDir | Out-Null
    Copy-Item -Path $env:OPENJARVIS_CONFIG -Destination (Join-Path $defaultConfigDir "config.toml") -Force

    $env:KAI_LOCAL_ONLY = "1"
    # Load oracle_keys.json and pass them as env vars to OpenJarvis so it uses them natively
    $oracleKeys = Get-Content (Join-Path $repoRoot "data\oracle_keys.json") -Raw | ConvertFrom-Json

    $env:OPENJARVIS_API_KEY = ""
    $env:OPENJARVIS_CONFIG = $env:OPENJARVIS_CONFIG
    $env:KAI_LOCAL_ONLY = "1"
    if (-not $env:KAI_MODEL) { $env:KAI_MODEL = "kai-next:latest" }

    if ($oracleKeys.groq)   { $env:GROQ_API_KEY   = $oracleKeys.groq }
    if ($oracleKeys.google) { $env:GOOGLE_API_KEY = $oracleKeys.google }
    if ($oracleKeys.openai) { $env:OPENAI_API_KEY = $oracleKeys.openai }
    if ($oracleKeys.xai)    { $env:XAI_API_KEY    = $oracleKeys.xai }

    # FUSION (brain vs memory — kept SEPARATE on purpose): OpenJarvis's MEMORY is
    # already the KAI lattice (rshl backend -> :3334), which is the real fusion. Its
    # LANGUAGE brain stays on Ollama 'kai-next:latest' — the ready, coherent model
    # Oracle has always spoken with. We do NOT route the talking through KAI's NATIVE
    # lattice generation yet, because that generation isn't ready and would make Oracle
    # dumb / talk like raw KAI. When the native brain IS ready, flip the engine with:
    #   $env:OPENJARVIS_ENGINE = "kai"
    $ojEngine = if ($env:OPENJARVIS_ENGINE) { $env:OPENJARVIS_ENGINE } else { "ollama" }
    Start-Process -FilePath $uvPath `
        -ArgumentList "run", "jarvis", "serve", "--host", "127.0.0.1", "--port", "8080", "--engine", $ojEngine `
        -WorkingDirectory $JarvisDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput $logOut `
        -RedirectStandardError $logErr

    # TRULY FIRE-AND-FORGET. The old code blocked the WHOLE system boot in a silent
    # 60s poll loop here -- and on a first run (uv syncing deps + Ollama warming the
    # model) that takes minutes, so startup just sat at "Waiting..." looking frozen.
    # OpenJarvis is an optional backend; nothing downstream needs it before booting.
    # So: quick courtesy check (in case it's already warm), then RETURN and let the
    # rest of the fleet boot while OpenJarvis finishes coming up in the background.
    Write-Host "[OpenJarvis] Launched in background. First run is SLOW (syncing deps + warming the model) -- it'll be live on http://127.0.0.1:8080 in a minute or two."
    for ($i = 0; $i -lt 6; $i++) {   # ~3s optimistic check only
        if (Test-JarvisReachable) {
            Write-Host "[OpenJarvis] Online and ready!"
            return
        }
        Start-Sleep -Milliseconds 500
    }
    Write-Host "[OpenJarvis] Still warming up in the background -- NOT blocking boot. It'll appear on :8080 shortly (logs: $logErr). Continuing startup..."
}

. (Join-Path $PSScriptRoot 'shared\fleet-health.ps1')
function Test-FleetAlreadyHealthy {
    $statePath = Join-Path $PSScriptRoot 'state\ecosystem-manager.json'
    if (Test-FleetManagerPulse -StatePath $statePath) { return $true }
    # Boot ramp: manager process + :3001 may be up before the first 15s heartbeat write.
    # Never Stop-ExistingDiscordGateways in that window - overlapping Start-KAI was
    # SIGKILLing a live fleet (~30-120s post-boot) and leaving zero nodes with no log.
    if (-not (Test-Path $statePath)) { return $false }
    try {
        $st = Get-Content $statePath -Raw | ConvertFrom-Json
        $mgrUp = $false
        if ($st.managerPid) {
            $mgrUp = $null -ne (Get-Process -Id $st.managerPid -ErrorAction SilentlyContinue)
        }
        $dashUp = [bool](netstat -ano | Select-String ':3001\s.*LISTENING')
        $nodeCount = @(Get-Process node -ErrorAction SilentlyContinue).Count
        if ($mgrUp -and $dashUp -and $nodeCount -ge 4) {
            Write-Host "[Startup] Fleet boot ramp detected (manager pid=$($st.managerPid), nodes=$nodeCount). Skipping duplicate boot - will attach." -ForegroundColor Yellow
            return $true
        }
    } catch {}
    return $false
}

function Stop-ExistingDiscordGateways {
    $currentPid = $PID
    $pRoot = $PSScriptRoot.Replace('\', '\\')
    $existing = Get-CimInstance Win32_Process |
        Where-Object {
            $_.ProcessId -ne $currentPid -and
            (($_.Name -match '^node(\.exe)?$') -or ($_.Name -match '^pwsh(\.exe)?$')) -and
            (($_.CommandLine -match 'oracle-discord|index\.mjs|run-oracle-discord|ecosystem-manager|start-bot|bots/') -or ($_.CommandLine -match $pRoot))
        }
    foreach ($process in $existing) {
        Write-Host "Stopping existing Oracle Discord gateway process $($process.ProcessId) ($($process.Name))."
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

# === MAIN ===
Push-Location $PSScriptRoot
try {
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

    if ($CheckOnly) {
        Write-Host "[CheckOnly] Validating configuration without starting anything."
    }

    Ensure-DiscordConfig

    # -- Step 1: Ensure Node dependencies are installed --------------------
    if (-not (Test-Path (Join-Path $PSScriptRoot "node_modules"))) {
        Write-Host "[Init] Installing Discord gateway dependencies..."
        npm install
        if ($LASTEXITCODE -ne 0) { throw "[Init] npm install failed (exit $LASTEXITCODE)" }
    }

    node index.mjs --check-config
    if ($LASTEXITCODE -ne 0) { throw "[Init] index.mjs --check-config failed (exit $LASTEXITCODE)" }
    if ($CheckOnly) {
        Write-Host "Check complete. Exiting without starting gateway."
        return
    }

    # -- Step 2: Kill existing gateway processes (skip if fleet already healthy) --
    if (Test-FleetAlreadyHealthy) {
        $st = Get-Content (Join-Path $PSScriptRoot 'state\ecosystem-manager.json') -Raw | ConvertFrom-Json
        Write-Host "[Startup] Fleet already healthy (manager pid=$($st.managerPid), :3001 up). Skipping duplicate boot — attaching to live manager." -ForegroundColor Green
        while ($null -ne (Get-Process -Id $st.managerPid -ErrorAction SilentlyContinue)) {
            Start-Sleep -Seconds 10
        }
        Write-Host "[Startup] Live manager exited — this launcher window can close." -ForegroundColor Yellow
        return
    }
    Stop-ExistingDiscordGateways

    # -- Step 3: Launch KAI + OpenJarvis in PARALLEL ----------------------
    # OpenJarvis is fire-and-forget. KAI is required - we wait for it.
    $jarvisDir = Join-Path $repoRoot "OpenJarvis-main"
    Write-Host ""
    Write-Host "[Startup] Phase 1 - Launching backends in parallel..."

    # Fire OpenJarvis immediately (non-blocking)
    Start-OpenJarvis -JarvisDir $jarvisDir

    # Now start KAI and wait for it (required for Discord gateway)
    if (-not $NoStartKai) {
        if (-not (Test-OracleReachable)) {
            Start-KaiOracle -RepoRoot $repoRoot
        } else {
            Write-Host "[KAI] Already reachable at http://127.0.0.1:3334"
        }
    }

    # -- Step 3.5: Autonomous Pre-Boot Codebase Scanner -------------------
    Write-Host ""
    Write-Host "[Startup] Phase 1.5 - KAI is autonomously scanning the codebase..."

    # READINESS GATE (additive): the scanner's deeper / LLM-assisted checks need
    # OpenJarvis (the cognitive core on :8080). OpenJarvis is launched fire-and-
    # forget above, so on a cold boot it may still be warming when we get here --
    # running the scan now would degrade it to "OpenJarvis core offline". So we
    # WAIT for :8080 to answer before scanning, polling every 2s up to a timeout.
    # Configurable via KAI_OJ_WAIT_SEC (default 120s). NON-FATAL: if it times out
    # we log a clear warning and continue anyway so boot never hangs forever.
    $ojWaitSec = 120
    if ($env:KAI_OJ_WAIT_SEC) {
        $parsed = 0
        if ([int]::TryParse($env:KAI_OJ_WAIT_SEC, [ref]$parsed) -and $parsed -gt 0) {
            $ojWaitSec = $parsed
        }
    }
    Write-Host "[Startup] Waiting up to $ojWaitSec s for OpenJarvis core (http://127.0.0.1:8080) before scanning..."
    $ojDeadline = (Get-Date).AddSeconds($ojWaitSec)
    $ojOnline = $false
    while ((Get-Date) -lt $ojDeadline) {
        if (Test-JarvisReachable) { $ojOnline = $true; break }
        Start-Sleep -Seconds 2
    }
    if ($ojOnline) {
        Write-Host "[Startup] OpenJarvis core online - running full scan."
    } else {
        Write-Host "[Startup] WARNING: OpenJarvis core did not come online within $ojWaitSec s - running scanner in DEGRADED mode (deeper/LLM-assisted checks will report 'OpenJarvis core offline'). Continuing boot." -ForegroundColor DarkYellow
    }

    $scannerScript = Join-Path $repoRoot "tools\oracle-discord\scripts\kai-scanner.mjs"
    node $scannerScript
    $scanExit = $LASTEXITCODE
    if ($scanExit -eq 2 -or $scanExit -ge 3) {
        # CORE-SAFE MODE -- a file had a syntax error Kai Coder couldn't auto-fix.
        # Instead of leaving you locked out (especially if you're not home), we
        # bring up ONLY KAI + Oracle + Dashboard so you can still talk to Oracle
        # and ask it to restart once the file is fixed. Everything else stays
        # asleep so a broken bot can't crash-loop. (Core can't sleep.)
        Write-Host ""
        Write-Host "[CORE-SAFE MODE] A file couldn't be auto-fixed. Starting ONLY KAI + Oracle + core." -ForegroundColor Yellow
        Write-Host "    You can DM Oracle to 'restart <bot>' or 'wake <bot>' once it's fixed." -ForegroundColor Yellow
        Write-Host ""
        $env:ORACLE_START_SLEEP_BOTS = "Gemini,Claudey,X,Groq,Analyst,Researcher,Kai Coder,Leo"
    }
    # exit 0 = all clear (or auto-fixed). We never fully halt anymore -- core
    # (KAI + Oracle) always comes up so you're never locked out remotely.

    # -- Step 3.9: Start sensor bridges (TinySA RF + Infiray IR) -----------
    # These were NEVER launched: the old sovereign-start referenced a
    # non-existent 'tinysa_bridge.py', and this launcher started nothing. The
    # real, working scripts are tinysa_discord_bridge.py (RF) and
    # thermal_bridge.py (Infiray IR). The engine is up by now, so they can feed
    # it on :3334 and post to the #frequencies channel. Skip with -NoSensors.
    if (-not $NoSensors) {
        $rfBridge = "C:\KAI\tools\tinysa_discord_bridge.py"
        $irBridge = "C:\KAI\tools\thermal_bridge.py"
        if (Test-Path $rfBridge) {
            $rfRunning = Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*tinysa_discord_bridge*' }
            if ($rfRunning) {
                Write-Host "[Sensors] TinySA RF bridge already running." -ForegroundColor DarkGray
            } else {
                Write-Host "[Sensors] Starting TinySA RF bridge (COM6 -> #frequencies)..." -ForegroundColor Magenta
                Start-Process -FilePath "python" -ArgumentList "`"$rfBridge`" --headless" -WorkingDirectory "C:\KAI\tools" -WindowStyle Hidden -ErrorAction SilentlyContinue
            }
        } else { Write-Host "[Sensors] TinySA bridge missing at $rfBridge" -ForegroundColor DarkYellow }
        if (Test-Path $irBridge) {
            $irRunning = Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*thermal_bridge*' }
            if ($irRunning) {
                Write-Host "[Sensors] Infiray IR bridge already running." -ForegroundColor DarkGray
            } else {
                Write-Host "[Sensors] Starting Infiray IR/thermal bridge..." -ForegroundColor Magenta
                Start-Process -FilePath "python" -ArgumentList "`"$irBridge`"" -WorkingDirectory "C:\KAI\tools" -WindowStyle Hidden -ErrorAction SilentlyContinue
            }
        } else { Write-Host "[Sensors] Thermal bridge missing at $irBridge" -ForegroundColor DarkYellow }
    }

    # -- Step 4: Start Discord gateway ------------------------------------
    Write-Host ""
    Write-Host "[Startup] Phase 2 - Backends online and codebase CLEARED. Starting microservices ecosystem..."
    Write-Host "[Startup] Bot output streams here (Leo, Oracle, KAI, Groq, ...)."
    Write-Host ""
    .\run-ecosystem.ps1
} finally {
    Pop-Location
}
