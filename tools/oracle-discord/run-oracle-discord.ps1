param(
    [switch]$CheckOnly,
    [switch]$NoStartKai
)

$ErrorActionPreference = "Stop"

function ConvertFrom-SecureStringPlain {
    param([System.Security.SecureString]$Secure)
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try {
        [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
}

function Ensure-DiscordConfig {
    if (-not $env:ORACLE_DISCORD_TOKEN) {
        Write-Host "Paste your Discord bot token. It will not be echoed or saved."
        $env:ORACLE_DISCORD_TOKEN = ConvertFrom-SecureStringPlain (Read-Host "ORACLE_DISCORD_TOKEN" -AsSecureString)
    }
    if (-not $env:ORACLE_DISCORD_ALLOWED_USER_ID) {
        Write-Host "Discord needs your numeric User ID, not your username."
        Write-Host "Enable Developer Mode, right-click your profile, then Copy User ID."
        $env:ORACLE_DISCORD_ALLOWED_USER_ID = Read-Host "ORACLE_DISCORD_ALLOWED_USER_ID"
    }
    if (-not $env:ORACLE_DISCORD_ALLOWED_CHANNEL_ID) {
        Write-Host "Optional: paste a numeric Channel ID to lock the bot to one channel, or press Enter to skip."
        $channel = Read-Host "ORACLE_DISCORD_ALLOWED_CHANNEL_ID"
        if (-not [string]::IsNullOrWhiteSpace($channel)) {
            $env:ORACLE_DISCORD_ALLOWED_CHANNEL_ID = $channel.Trim()
        }
    }
}

function Test-OracleReachable {
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:3333/api/session" -Method Get -TimeoutSec 2 | Out-Null
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
        Write-Host "Check complete. Discord gateway config is ready."
        return
    }

    if (-not $NoStartKai -and -not (Test-OracleReachable)) {
        Start-KaiOracle -RepoRoot $repoRoot
    }

    Write-Host "Starting Oracle Discord gateway. Leave this PowerShell window open."
    npm start
} finally {
    Pop-Location
}
