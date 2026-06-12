param(
    [switch]$CheckOnly,
    [switch]$NoStartKai,
    [switch]$ConfigureMain,
    [switch]$ConfigureSpeakers,
    [switch]$ConfigureVoice,
    [switch]$FullFleet,
    [switch]$NoPhoneBridge,
    [string]$PhoneHost = "0.0.0.0",
    [int]$PhonePort = 8787,
    [ValidateSet("local", "tailnet", "any")]
    [string]$PhoneAllowSource = "tailnet"
)

$ErrorActionPreference = "Stop"
$script = Join-Path $PSScriptRoot "tools\oracle-discord\run-oracle-discord.ps1"

if (-not (Test-Path $script)) {
    throw "Oracle Discord launcher not found at $script"
}

& $script @PSBoundParameters
if (-not $?) {
    exit 1
}
exit 0
