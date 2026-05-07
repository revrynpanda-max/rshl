@echo off
setlocal
title RSHL Sovereign Architecture Bench — 16k Comparison Audit

cd /d "%~dp0"

echo.
echo  ============================================================
echo   RSHL SOVEREIGN ARCHITECTURE BENCH  —  COMPARISON AUDIT
echo  ============================================================
echo.
echo  This runs the SAME probe checklist TWICE:
echo.
echo  Phase 1  "BASELINE ENVIRONMENT"
echo           Standard 4k-dimension baseline performance.
echo.
echo  Phase 2  "SOVEREIGN ARCHITECTURE"
echo           Full 16k-dimension industrial stack with 
echo           Golden Ratio torsion and <1ms hardware links.
echo.
echo  Starting dual-phase audit... (estimated 2-4 minutes)
echo.

node benchmarks\universal_layer_bench_v2.mjs

if %ERRORLEVEL% equ 0 (
  echo.
  echo  [Success] Comparison complete. Dual-phase report saved to reports\
) else (
  echo.
  echo  [Error] Benchmarking failed. Check output above.
)

echo.
pause
exit /b %ERRORLEVEL%
