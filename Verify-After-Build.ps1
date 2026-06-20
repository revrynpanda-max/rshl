# ============================================================================
#  Verify-After-Build.ps1  -  rebuild the engine, prove the new code, launch all
# ============================================================================
#  1. cargo build --release  (compiles the v9.8.7 engine incl. word_calculus)
#  2. cargo test word_calculus  (proves the language module's math passes)
#  3. .\Start-KAI.ps1  (boots engine + ollama + supervisor + fleet, in order)
#  Stops and tells you exactly what to paste back if the build or tests fail.
#  Run:   .\Verify-After-Build.ps1            (build, test, launch)
#         .\Verify-After-Build.ps1 -NoStart   (build + test only)
# ============================================================================
param([switch]$NoStart)
$ErrorActionPreference = "Stop"
Set-Location "C:\KAI"

Write-Host ""
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "  VERIFY-AFTER-BUILD  -  rebuild, test, launch" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan

Write-Host "[1/3] cargo build --release  (engine v9.8.7, includes word_calculus)..." -ForegroundColor Yellow
cargo build --release --bin kai
if ($LASTEXITCODE -ne 0) {
    Write-Host "  BUILD FAILED. Paste the red error lines back and I'll fix them." -ForegroundColor Red
    exit 1
}
Write-Host "  build OK." -ForegroundColor Green

Write-Host "[2/3] cargo test word_calculus  (proves the language module works)..." -ForegroundColor Yellow
cargo test word_calculus
if ($LASTEXITCODE -ne 0) {
    Write-Host "  TESTS FAILED. Paste the test output back and I'll fix the logic." -ForegroundColor Red
    exit 1
}
Write-Host "  word-calculus tests PASS." -ForegroundColor Green

if ($NoStart) {
    Write-Host ""
    Write-Host "Done (build + test only). Launch when ready with:  .\Start-KAI.ps1" -ForegroundColor Green
    exit 0
}

Write-Host "[3/3] Launching the full system (Start-KAI.ps1)..." -ForegroundColor Yellow
Write-Host ""
& "C:\KAI\Start-KAI.ps1"
