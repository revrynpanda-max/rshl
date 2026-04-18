@echo off
chcp 65001 >nul 2>&1

:: Generate ESC character for ANSI codes
for /F "delims=#" %%E in ('"prompt #$E & for %%E in (1) do rem"') do set "ESC=%%E"

set "GREEN=%ESC%[92m"
set "CYAN=%ESC%[96m"
set "YELLOW=%ESC%[93m"
set "WHITE=%ESC%[97m"
set "DIM=%ESC%[90m"
set "RESET=%ESC%[0m"
set "BOLD=%ESC%[1m"

cls
echo.
echo %CYAN%============================================================%RESET%
echo %BOLD%%WHITE%  RSHL + KAI -- Full Benchmark Suite%RESET%
echo %DIM%  Speed - Accuracy - Lattice - Rust Engine - All Tests%RESET%
echo %CYAN%============================================================%RESET%
echo.
echo %DIM%  Hardware: Ryzen 5 8645HS + RTX 4050 + 40GB RAM + AVX2+OMP%RESET%
echo.

echo %YELLOW%------------------------------------------------------------
echo   1/4  RSHL Speed Benchmark%RESET%
echo %DIM%  Running: node bench.js --save%RESET%
echo.
node bench.js --save
echo.

echo %YELLOW%------------------------------------------------------------
echo   2/4  Recall Accuracy%RESET%
echo %DIM%  Running: node eval/recall-accuracy.js%RESET%
echo.
node eval/recall-accuracy.js
echo.

echo %YELLOW%------------------------------------------------------------
echo   3/4  Lattice Eval%RESET%
echo %DIM%  Running: node eval/lattice-eval.js%RESET%
echo.
node eval/lattice-eval.js
echo.

echo %YELLOW%------------------------------------------------------------
echo   4/4  Rust Engine Tests%RESET%
echo %DIM%  Running: cargo test --release%RESET%
echo.
cd kai-rust
cargo test --release
cd ..
echo.

echo %GREEN%============================================================%RESET%
echo %BOLD%%GREEN%  ALL BENCHMARKS COMPLETE%RESET%
echo %GREEN%============================================================%RESET%
echo.
echo %GREEN%  Results saved to: reports/%RESET%
echo %DIM%  Run again anytime: .\bench-all.bat%RESET%
echo.
pause
