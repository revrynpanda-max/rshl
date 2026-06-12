param(
    [switch]$CheckOnly,
    [switch]$NoStartKai,
    [Parameter(Mandatory=$false)]
    [switch]$ConfigureMain,
    [Parameter(Mandatory=$false)]
    [switch]$ConfigureSpeakers,
    [switch]$ConfigureVoice,
    [switch]$FullFleet,
    [switch]$NoPhoneBridge,
    [string]$PhoneHost = "0.0.0.0",
    [int]$PhonePort = 8787,
    [ValidateSet("local", "tailnet", "any")]
    [string]$PhoneAllowSource = "tailnet"
)

# Force UTF-8 so Unicode characters display correctly in PowerShell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$ErrorActionPreference = "Stop"

# === FORCE PERSISTENT PHONE SENSOR TOKEN (never regenerate on restart) ===
# Load from saved state file so the token stays the same across restarts of run-oracle-discord.ps1
$phoneStatePath = Join-Path $PSScriptRoot "state\phone_sensor_connection.json"
if (Test-Path $phoneStatePath) {
    try {
        $phoneConn = Get-Content $phoneStatePath -Raw | ConvertFrom-Json
        if ($phoneConn.token -and -not $env:KAI_PHONE_SENSOR_TOKEN) {
            $env:KAI_PHONE_SENSOR_TOKEN = [string]$phoneConn.token
            Write-Host "[Phone] Loaded persistent token from saved state (will not change on restart)."
        }
    } catch {
        Write-Warning "Could not load phone token from state file."
    }
}
$ConfigPath = Join-Path $PSScriptRoot ".oracle-discord.local.xml"
$ParticipantTokenNames = @(
    @{ Name = "KAI";          Env = "ORACLE_DISCORD_TOKEN_KAI" },
    @{ Name = "Leo";          Env = "ORACLE_DISCORD_TOKEN_LEO" },
    @{ Name = "Analyst";      Env = "ORACLE_DISCORD_TOKEN_ANALYST" },
    @{ Name = "Researcher";   Env = "ORACLE_DISCORD_TOKEN_RESEARCHER" },
    @{ Name = "Groq";         Env = "ORACLE_DISCORD_TOKEN_GROQ" },
    @{ Name = "X";            Env = "ORACLE_DISCORD_TOKEN_X" },
    @{ Name = "Claudey";       Env = "ORACLE_DISCORD_TOKEN_CLAUDEY" },
    @{ Name = "Gemini";       Env = "ORACLE_DISCORD_TOKEN_GEMINI" },
    @{ Name = "GPT";          Env = "ORACLE_DISCORD_TOKEN_GPT" },
    @{ Name = "Oracle Coder"; Env = "ORACLE_DISCORD_TOKEN_ORACLE_CODER" }
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
        if ($config.Token -and -not $env:ORACLE_DISCORD_TOKEN) {
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
        $env:ORACLE_DISCORD_LEO_VOICE_CHANNEL_ID = "1505088473307283517"
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

    # Already running — nothing to do
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
    if (-not $uvPath) { $uvPath = "C:\Users\$env:USERNAME\miniconda3\Scripts\uv.exe" }
    if (-not (Test-Path $uvPath)) { $uvPath = "$env:USERPROFILE\.local\bin\uv.exe" }
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

    Start-Process -FilePath $uvPath `
        -ArgumentList "run", "jarvis", "serve", "--port", "8080", "--engine", "ollama" `
        -WorkingDirectory $JarvisDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput $logOut `
        -RedirectStandardError $logErr

    Write-Host "[OpenJarvis] Process launched. Waiting for it to become available at http://127.0.0.1:8080..."
    
    for ($i = 0; $i -lt 120; $i++) {
        if (Test-JarvisReachable) {
            Write-Host "[OpenJarvis] Online and ready!"
            return
        }
        Start-Sleep -Milliseconds 500
    }
    
    Write-Host "[OpenJarvis] Warning: Did not become reachable in time. Check $logErr"
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

function New-PhoneBridgeToken {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    } finally {
        $rng.Dispose()
    }
    return ([Convert]::ToBase64String($bytes)).TrimEnd('=').Replace('+','-').Replace('/','_')
}

function Get-TailscaleIPv4 {
    $ts = Get-Command tailscale -ErrorAction SilentlyContinue
    if ($ts) {
        try {
            $ip = (& $ts.Source ip -4 2>$null | Select-Object -First 1).Trim()
            if ($ip -match '^100\.') { return $ip }
        } catch {}
    }
    $net = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -match '^100\.' } |
        Select-Object -First 1
    if ($net) { return $net.IPAddress }
    return "100.70.177.87"
}

function Initialize-PhoneSensorBridgeConfig {
    param([string]$RepoRoot)

    $tailscaleIp = Get-TailscaleIPv4
    $stateDir = Join-Path $PSScriptRoot "state"
    New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
    $connectionPath = Join-Path $stateDir "phone_sensor_connection.json"
    $tokenSource = "environment"
    if (-not $env:KAI_PHONE_SENSOR_TOKEN -and (Test-Path $connectionPath)) {
        try {
            $existing = Get-Content $connectionPath -Raw | ConvertFrom-Json
            if ($existing.token) {
                $env:KAI_PHONE_SENSOR_TOKEN = [string]$existing.token
                $tokenSource = "state"
            }
        } catch {
            $tokenSource = "generated"
        }
    }
    if (-not $env:KAI_PHONE_SENSOR_TOKEN) {
        $env:KAI_PHONE_SENSOR_TOKEN = New-PhoneBridgeToken
        $tokenSource = "generated"
    }

    [pscustomobject]@{
        updatedAt = (Get-Date).ToUniversalTime().ToString("o")
        bridgeUrl = "http://${tailscaleIp}:${PhonePort}/phone"
        phyphoxUrl = "http://${tailscaleIp}:${PhonePort}/phyphox"
        healthUrl = "http://127.0.0.1:${PhonePort}/health"
        latestUrl = "http://127.0.0.1:${PhonePort}/latest"
        tailscaleIp = $tailscaleIp
        bindHost = $PhoneHost
        port = $PhonePort
        allowSource = $PhoneAllowSource
        token = $env:KAI_PHONE_SENSOR_TOKEN
        tokenSource = $tokenSource
        note = "Keep this token private. Oracle can DM these details to the authorized owner."
    } | ConvertTo-Json -Depth 5 | Set-Content -Path $connectionPath -Encoding UTF8

    Write-Host "[Phone] Sensor bridge prepared: http://${tailscaleIp}:${PhonePort}/phone (allow-source=$PhoneAllowSource)"
    Write-Host "        Phyphox-friendly: http://${tailscaleIp}:${PhonePort}/phyphox"
    Write-Host "        Health: http://127.0.0.1:${PhonePort}/health   Latest: http://127.0.0.1:${PhonePort}/latest"
    Write-Host "        Token (for phone POSTs): $env:KAI_PHONE_SENSOR_TOKEN"
    Write-Host "        On your PHONE (via Tailscale + Phyphox or custom sender): POST JSON telemetry to the /telemetry or /phyphox URL above."
    Write-Host "        Example minimal payload: { 'device_id':'phone-main', 'location':{'lat':xx,'lon':yy}, 'sensors':{ 'battery_pct':xx, 'accelerometer':{...} } }"
    Write-Host "        KAI will ingest it into the lattice for real-time awareness / protection."
    Write-Host "[Phone] Connection state saved to $connectionPath"
}

Push-Location $PSScriptRoot
try {
    $repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")

    # ── Step 0: Flush session environment ────────────────────────────────
    Clear-DiscordEnvConfig

    # ── Step 1: Load environment ──────────────────────────────────────────
    $envFile = Join-Path $PSScriptRoot ".env"
    if (Test-Path $envFile) {
        Write-Host "[Init] Loading .env..."
        Get-Content $envFile | Where-Object { $_ -match '^\s*[A-Za-z0-9_]+\s*=' } | ForEach-Object {
            $name, $value = $_.Split('=', 2)
            Set-Item "Env:$($name.Trim())" $value.Trim()
        }
    }
    Ensure-DiscordConfig

    if (-not $FullFleet) {
        # ESSENTIALS MODE: Leo + core (Oracle, KAI, Dashboard) + helpers online.
        # Social bots start ASLEEP so they can't fight Leo for the GPU.
        # Wake any of them in Discord: "wake groq", "wake up all", etc.
        $env:ORACLE_START_SLEEP_BOTS = "Gemini,Claudey,X,Groq"
        $env:ORACLE_LOW_CPU_PHONE_MODE = "1"
        Write-Host "[Power] Essentials mode: Leo + core + helpers online; social bots (Gemini, Claudey, X, Groq) start asleep." -ForegroundColor Yellow
        Write-Host "[Power] Wake them via Oracle in Discord ('wake groq') or boot with -FullFleet for everyone." -ForegroundColor DarkYellow
    } else {
        Remove-Item "Env:ORACLE_START_SLEEP_BOTS" -ErrorAction SilentlyContinue
        Remove-Item "Env:ORACLE_LOW_CPU_PHONE_MODE" -ErrorAction SilentlyContinue
        Write-Host "[Power] Full fleet mode requested. No startup sleep list applied." -ForegroundColor Yellow
    }

    if (-not $NoPhoneBridge) {
        Initialize-PhoneSensorBridgeConfig -RepoRoot $repoRoot
    } else {
        Write-Host "[Phone] -NoPhoneBridge set; phone sensor bridge will not be launched by watchdog." -ForegroundColor Yellow
    }

    if (-not (Test-Path (Join-Path $PSScriptRoot "node_modules"))) {
        Write-Host "[Init] Installing Discord gateway dependencies..."
        npm install
    }

    node index.mjs --check-config
    if ($CheckOnly) {
        Write-Host "Check complete. Exiting without starting gateway."
        return
    }

    # ── Step 2: Kill existing gateway processes ───────────────────────────
    Write-Host "[Init] Hard-resetting environment to prevent port conflicts..." -ForegroundColor Yellow
    Stop-Process -Name node -Force -ErrorAction SilentlyContinue
    if (-not $NoStartKai) {
        Stop-Process -Name kai -Force -ErrorAction SilentlyContinue
        $port3334 = Get-NetTCPConnection -LocalPort 3334 -ErrorAction SilentlyContinue
        if ($port3334) { $port3334 | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }
    } else {
        Write-Host "[Init] -NoStartKai set; preserving any existing KAI/CNS process on port 3334."
    }
    $port3001 = Get-NetTCPConnection -LocalPort 3001 -ErrorAction SilentlyContinue
    if ($port3001) { $port3001 | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }
    Start-Sleep -Seconds 2
    Stop-ExistingDiscordGateways

    # ── Step 3: Launch KAI + OpenJarvis in PARALLEL ───────────────────────
    # OpenJarvis is fire-and-forget. KAI is required — we wait for it.
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

    # Wait for KAI CNS to initialize before attaching sensors
    Write-Host "      Waiting 3s for CNS to initialize..." -ForegroundColor DarkGray
    Start-Sleep -Seconds 3

    # ── Step 3.5: START SENSORY LAYER (RF + IR) ───────────────────────────
    Write-Host ""
    Write-Host "[Startup] Phase 1.5 - Launching Sensory Layer (RF + IR)..." -ForegroundColor Magenta
    
    # Kill any leftover sensor processes
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            if ($_.CommandLine -like "*sensor_watchdog.ps1*") {
                $_.Terminate() | Out-Null
            }
        } catch {}
    }
    Get-WmiObject Win32_Process -Filter "Name='python.exe' OR Name='python3.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            if ($_.CommandLine -like "*tinysa_bridge*" -or $_.CommandLine -like "*tinysa_discord_bridge*" -or $_.CommandLine -like "*tinysa_fusion_bridge*" -or $_.CommandLine -like "*ir_bridge*" -or $_.CommandLine -like "*sensor_watchdog*" -or $_.CommandLine -like "*phone_sensor_bridge*") {
                $_.Terminate() | Out-Null
            }
        } catch {}
    }

    Write-Host "      [RF] Starting KAI RF Fusion Bridge on COM6..." -ForegroundColor DarkGray
    Start-Process -FilePath "python" `
                  -ArgumentList "C:\KAI\tools\tinysa_fusion_bridge.py --headless --port COM6 --discord-channel 1513582425446289658" `
                  -WindowStyle Hidden `
                  -ErrorAction SilentlyContinue

    # [DISABLED 2026-06-10] ir_bridge.py loops cv2.VideoCapture every 10s when no IR camera
    # is connected, which triggers the Windows device/permission sound endlessly.
    # This was already disabled in sensor_watchdog.ps1 but this launcher still started it.
    # Re-enable by uncommenting when an actual IR/thermal camera is plugged in.
    # Write-Host "      [IR] Starting IR camera bridge..." -ForegroundColor DarkGray
    # Start-Process -FilePath "python" `
    #               -ArgumentList "C:\KAI\tools\ir_bridge.py --headless" `
    #               -WindowStyle Hidden `
    #               -ErrorAction SilentlyContinue

    Write-Host "      [WD] Starting Sensor Watchdog..." -ForegroundColor DarkGray

    # Explicitly release phone sensor port (8787) and others to guarantee no duplicates.
    # This is critical for reliable real-time phone telemetry (location, accel, battery, etc.)
    # that feeds KAI's lattice for protection awareness and future device adaptability (robot body, wearables, etc.).
    Write-Host "      Releasing sensor ports (especially 8787 for phone data) to prevent duplicate bindings..."
    powershell -Command "& { $ports = @(8787,3333,3334,3400,3401); foreach($p in $ports){ netstat -ano | findstr \":$p\" | ForEach-Object { $id = ($_ -split '\s+')[-1]; if($id -match '^\d+$'){ taskkill /F /PID $id 2>$null } } } }" | Out-Null

    $watchdogArgs = @(
        "-WindowStyle", "Hidden",
        "-ExecutionPolicy", "Bypass",
        "-File", "C:\KAI\tools\sensors\sensor_watchdog.ps1"
    )
    if (-not $NoPhoneBridge) {
        $watchdogArgs += @(
            "-EnablePhoneBridge",
            "-PhoneHost", $PhoneHost,
            "-PhonePort", "$PhonePort",
            "-PhoneAllowSource", $PhoneAllowSource,
            "-PhoneToken", $env:KAI_PHONE_SENSOR_TOKEN
        )
    }
    Start-Process -FilePath "powershell" `
                  -ArgumentList $watchdogArgs `
                  -WindowStyle Hidden `
                  -ErrorAction SilentlyContinue

    Write-Host "      Sensory layer online: RF Discord vision + IR thermal awareness active." -ForegroundColor DarkGray

    # ── Step 4: Start Discord gateway ─────────────────────────────────────
    Write-Host ""
    Write-Host "[Startup] Phase 2 - Backends online. Starting microservices ecosystem..."
    Write-Host ""

    # Support easy "essentials" mode for your workflow (live Leo + Oracle + KAI core + learning pipeline).
    # Set this env BEFORE running the script (or export it) to sleep the heavy specialists:
    #   $env:ORACLE_START_SLEEP_BOTS = 'Analyst,Researcher,"Kai Coder",Gemini,Claudey,X,Groq'
    # This keeps CPU/RAM headroom for Leo voice, Oracle orchestration, the sovereign KAI lattice,
    # and your overnight_pipeline.py learning without the machine going crazy.
    if ($env:ORACLE_START_SLEEP_BOTS) {
        Write-Host "[Essentials] ORACLE_START_SLEEP_BOTS active: $($env:ORACLE_START_SLEEP_BOTS)" -ForegroundColor Yellow
    }

    .\run-ecosystem.ps1 -HealthWaitSec 60
} finally {
    Pop-Location
}

function New-PhoneBridgeToken {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    } finally {
        $rng.Dispose()
    }
    return ([Convert]::ToBase64String($bytes)).TrimEnd('=').Replace('+','-').Replace('/','_')
}

function Get-TailscaleIPv4 {
    $ts = Get-Command tailscale -ErrorAction SilentlyContinue
    if ($ts) {
        try {
            $ip = (& $ts.Source ip -4 2>$null | Select-Object -First 1).Trim()
            if ($ip -match '^100\.') { return $ip }
        } catch {}
    }
    $net = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -match '^100\.' } |
        Select-Object -First 1
    if ($net) { return $net.IPAddress }
    return "100.70.177.87"
}

function Initialize-PhoneSensorBridgeConfig {
    param([string]$RepoRoot)

    $tailscaleIp = Get-TailscaleIPv4
    $stateDir = Join-Path $PSScriptRoot "state"
    New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
    $connectionPath = Join-Path $stateDir "phone_sensor_connection.json"
    $tokenSource = "environment"
    if (-not $env:KAI_PHONE_SENSOR_TOKEN -and (Test-Path $connectionPath)) {
        try {
            $existing = Get-Content $connectionPath -Raw | ConvertFrom-Json
            if ($existing.token) {
                $env:KAI_PHONE_SENSOR_TOKEN = [string]$existing.token
                $tokenSource = "state"
            }
        } catch {
            $tokenSource = "generated"
        }
    }
    if (-not $env:KAI_PHONE_SENSOR_TOKEN) {
        $env:KAI_PHONE_SENSOR_TOKEN = New-PhoneBridgeToken
        $tokenSource = "generated"
    }

    [pscustomobject]@{
        updatedAt = (Get-Date).ToUniversalTime().ToString("o")
        bridgeUrl = "http://${tailscaleIp}:${PhonePort}/phone"
        phyphoxUrl = "http://${tailscaleIp}:${PhonePort}/phyphox"
        healthUrl = "http://127.0.0.1:${PhonePort}/health"
        latestUrl = "http://127.0.0.1:${PhonePort}/latest"
        tailscaleIp = $tailscaleIp
        bindHost = $PhoneHost
        port = $PhonePort
        allowSource = $PhoneAllowSource
        token = $env:KAI_PHONE_SENSOR_TOKEN
        tokenSource = $tokenSource
        note = "Keep this token private. Oracle can DM these details to the authorized owner."
    } | ConvertTo-Json -Depth 5 | Set-Content -Path $connectionPath -Encoding UTF8

    Write-Host "[Phone] Sensor bridge prepared: http://${tailscaleIp}:${PhonePort}/phone (allow-source=$PhoneAllowSource)"
    Write-Host "        Phyphox-friendly: http://${tailscaleIp}:${PhonePort}/phyphox"
    Write-Host "        Health: http://127.0.0.1:${PhonePort}/health   Latest: http://127.0.0.1:${PhonePort}/latest"
    Write-Host "        Token (for phone POSTs): $env:KAI_PHONE_SENSOR_TOKEN"
    Write-Host "        On your PHONE (via Tailscale + Phyphox or custom sender): POST JSON telemetry to the /telemetry or /phyphox URL above."
    Write-Host "        Example minimal payload: { 'device_id':'phone-main', 'location':{'lat':xx,'lon':yy}, 'sensors':{ 'battery_pct':xx, 'accelerometer':{...} } }"
    Write-Host "        KAI will ingest it into the lattice for real-time awareness / protection."
    Write-Host "[Phone] Connection state saved to $connectionPath"
}

