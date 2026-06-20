# build-native.ps1 — one-shot: rebuild KAI and report status to a file the
# assistant checks on a timer. Run this in PowerShell:  .\build-native.ps1
# (Saves you babysitting the compile; the scheduled check reads the status below.)

$ErrorActionPreference = "Continue"
$root     = "C:\KAI"
$stateDir = Join-Path $root "tools\oracle-discord\state"
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$log    = Join-Path $stateDir "native_build.log"
$status = Join-Path $stateDir "native_status.json"

function Write-Status($stage, $ok, $err) {
    @{
        stage      = $stage
        ok         = $ok
        error_tail = $err
        timestamp  = (Get-Date).ToString("o")
    } | ConvertTo-Json -Compress | Set-Content -Path $status -Encoding UTF8
}

Set-Location $root
Write-Status "building" $false ""
"== KAI native build started $(Get-Date) ==" | Out-File $log -Encoding UTF8

# Plain (CPU) build. The LLM device-selection + activation-entropy gauge + the
# NATIVE_ONLY routing all land here. (Add --features llm-cuda later, only after
# the CUDA toolkit is installed, to move the live LLM to the GPU.)
cargo build --release --bin kai 2>&1 | Tee-Object -FilePath $log -Append
$code = $LASTEXITCODE

if ($code -eq 0) {
    Write-Status "built" $true ""
    Write-Host ""
    Write-Host "BUILD OK." -ForegroundColor Green
    Write-Host "Run KAI in NATIVE mode (no Llama, no Ollama - pure lattice):"
    Write-Host '    $env:KAI_NATIVE_ONLY=1 ; .\target\release\kai.exe' -ForegroundColor Cyan
    Write-Host "Then talk to him and judge the native output. To go back to the live model, just don't set KAI_NATIVE_ONLY."
} else {
    $tail = (Get-Content $log -Tail 50) -join "`n"
    Write-Status "failed" $false $tail
    Write-Host ""
    Write-Host "BUILD FAILED (exit $code). Full log: $log" -ForegroundColor Red
    Write-Host "The assistant's scheduled check will read the error tail and propose fixes."
}
