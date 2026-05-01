param(
    [switch]$CheckOnly,
    [switch]$NoStartKai,
    [Parameter(Mandatory=$false)]
    [switch]$ConfigureMain,
    [Parameter(Mandatory=$false)]
    [switch]$ConfigureSpeakers,
    [switch]$ConfigureVoice
)

$ErrorActionPreference = "Stop"
$ConfigPath = Join-Path $PSScriptRoot ".oracle-discord.local.xml"
$ParticipantTokenNames = @(
    @{ Name = "KAI"; Env = "ORACLE_DISCORD_TOKEN_KAI" },
    @{ Name = "Leo"; Env = "ORACLE_DISCORD_TOKEN_LEO" },
    @{ Name = "Analyst"; Env = "ORACLE_DISCORD_TOKEN_ANALYST" },
    @{ Name = "Researcher"; Env = "ORACLE_DISCORD_TOKEN_RESEARCHER" },
    @{ Name = "Groq"; Env = "ORACLE_DISCORD_TOKEN_GROQ" },
    @{ Name = "X"; Env = "ORACLE_DISCORD_TOKEN_X" },
    @{ Name = "KAI"; Env = "ORACLE_DISCORD_TOKEN_CLAUDE" },
    @{ Name = "Gemini"; Env = "ORACLE_DISCORD_TOKEN_GEMINI" },
    @{ Name = "GPT"; Env = "ORACLE_DISCORD_TOKEN_GPT" }
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
        Invoke-RestMethod -Uri "http://127.0.0.1:3333/api/session" -Method Get -TimeoutSec 2 | Out-Null
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
        -WorkingDirectory $RepoRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr | Out-Null

    for ($i = 0; $i -lt 60; $i++) {
        if (Test-OracleReachable) {
            Write-Host "Oracle is reachable at http://127.0.0.1:3333"
            return
        }
        Start-Sleep -Milliseconds 500
    }

    throw "KAI started, but Oracle did not become reachable. Check $stderr"
}

function Start-OpenJarvis {
    param([string]$JarvisDir)

    if (-not (Test-Path $JarvisDir)) {
        Write-Warning "OpenJarvis directory not found at $JarvisDir. Skipping."
        return
    }

    # Check if already running on 8080
    $alreadyUp = $false
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:8080/" -Method Get -TimeoutSec 2 | Out-Null
        $alreadyUp = $true
    } catch {}

    if ($alreadyUp) {
        Write-Host "OpenJarvis workspace already running at http://127.0.0.1:8080"
        return
    }

    Write-Host "Starting OpenJarvis workspace (Oracle backbone)..."

    $scratch = Join-Path (Split-Path $JarvisDir -Parent) "scratch"
    New-Item -ItemType Directory -Force -Path $scratch | Out-Null
    $logOut = Join-Path $scratch "openjarvis.out.log"
    $logErr = Join-Path $scratch "openjarvis.err.log"

    # Set Oracle config so OpenJarvis loads our custom setup
    $env:OPENJARVIS_CONFIG = Join-Path $JarvisDir "configs\openjarvis\config.toml"

    # Resolve full path to uv so it works from a background process
    $uvPath = (Get-Command uv -ErrorAction SilentlyContinue).Source
    if (-not $uvPath) { $uvPath = "$env:USERPROFILE\.local\bin\uv.exe" }
    if (-not (Test-Path $uvPath)) { $uvPath = "C:\Users\$env:USERNAME\.local\bin\uv.exe" }

    Write-Host "  uv path: $uvPath"
    Write-Host "  config:  $env:OPENJARVIS_CONFIG"

    # Copy our config to the default location so OpenJarvis always finds it
    # even if OPENJARVIS_CONFIG env var doesn't propagate through uv
    $defaultConfigDir = Join-Path $env:USERPROFILE ".openjarvis"
    New-Item -ItemType Directory -Force -Path $defaultConfigDir | Out-Null
    Copy-Item -Path $env:OPENJARVIS_CONFIG -Destination (Join-Path $defaultConfigDir "config.toml") -Force
    Write-Host "  config synced to: $defaultConfigDir\config.toml"

    # KAI_LOCAL_ONLY=1 -- prevents OpenJarvis from wrapping Ollama with cloud
    # engines just because OPENAI_API_KEY/GOOGLE_API_KEY are present in env
    # (those keys are for Discord TTS/Gemini, not for OpenJarvis inference)
    $env:KAI_LOCAL_ONLY = "1"
    $env:KAI_MODEL = if ($env:KAI_MODEL) { $env:KAI_MODEL } else { "kai-next:latest" }

    # Launch uv run jarvis serve in background, hidden window
    Start-Process -FilePath $uvPath `
        -ArgumentList "run", "jarvis", "serve", "--port", "8080", "--engine", "ollama" `
        -WorkingDirectory $JarvisDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput $logOut `
        -RedirectStandardError $logErr

    # Wait up to 60s for it to come up
    for ($i = 0; $i -lt 120; $i++) {
        try {
            Invoke-RestMethod -Uri "http://127.0.0.1:8080/" -Method Get -TimeoutSec 1 | Out-Null
            Write-Host "OpenJarvis workspace online at http://127.0.0.1:8080"
            return
        } catch {}
        Start-Sleep -Milliseconds 500
    }
    Write-Warning "OpenJarvis started but taking long to respond - check $logErr. Continuing..."
}

function Stop-ExistingDiscordGateways {
    $currentPid = $PID
    $existing = Get-CimInstance Win32_Process |
        Where-Object {
            $_.ProcessId -ne $currentPid -and
            ($_.Name -match '^node(\.exe)?$') -and
            ($_.CommandLine -match 'oracle-discord|index\.mjs|run-oracle-discord')
        }
    foreach ($process in $existing) {
        Write-Host "Stopping existing Oracle Discord gateway process $($process.ProcessId)."
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

Push-Location $PSScriptRoot
try {
    $repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
    Ensure-DiscordConfig

    if (-not (Test-Path (Join-Path $PSScriptRoot "node_modules"))) {
        Write-Host "Installing Discord gateway dependencies..."
        npm install
    }

    node index.mjs --check-config
    if ($CheckOnly) {
        Write-Host "Check complete. Exiting without starting gateway."
        return
    }

    Stop-ExistingDiscordGateways

    if (-not $NoStartKai) {
        if (-not (Test-OracleReachable)) {
            Start-KaiOracle -RepoRoot $repoRoot
        } else {
            Write-Host "Oracle is already reachable at http://127.0.0.1:3333"
        }
    }

    # Start OpenJarvis workspace (Oracle's agentic backbone)
    $jarvisDir = Join-Path $repoRoot "OpenJarvis-main"
    Start-OpenJarvis -JarvisDir $jarvisDir

    Write-Host "Starting Oracle Discord gateway..."
    node index.mjs
} finally {
    Pop-Location
}
