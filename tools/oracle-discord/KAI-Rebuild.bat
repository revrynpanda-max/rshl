@echo off
REM One-click production rebuild of the KAI engine.
REM Carries: admission control (caps concurrent queries — THE fix for the
REM constant engine timeouts), real hippocampus stats feed, and all pending
REM Rust-side improvements. Takes 10-30 minutes (LTO build). Run while the
REM fleet is stopped or quiet for fastest results.
cd /d C:\KAI
echo ============================================================
echo  KAI ENGINE PRODUCTION REBUILD (cargo --release, LTO)
echo  This is the fix for the constant engine timeouts.
echo  Expect 10-30 minutes. Do not close this window.
echo ============================================================
cargo build --release --bin kai
if %ERRORLEVEL% NEQ 0 (
  echo.
  echo *** BUILD FAILED — copy the error above and paste it to Claude. ***
  pause
  exit /b 1
)
echo.
echo ============================================================
echo  BUILD SUCCEEDED. Restart the system to load the new engine:
echo    - In Discord: tell Oracle "restart the whole show"
echo    - Or run: KAI-Start.bat
echo ============================================================
pause
