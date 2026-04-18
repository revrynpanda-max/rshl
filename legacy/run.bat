@echo off
title RSHL Benchmark
color 0A
cls

echo.
echo  ================================================
echo   RSHL - Sparse Ternary Memory Engine Benchmark
echo  ================================================
echo.

:: ── Check Node.js ────────────────────────────────────────────────────────────
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Node.js is not installed.
    echo.
    echo  Download from: https://nodejs.org
    echo  Install the LTS version, then run this file again.
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node -e "process.stdout.write(process.version)"') do set NODE_VER=%%v
echo  Node.js %NODE_VER% found.
echo.

:: ── Try pre-built native addon ───────────────────────────────────────────────
node -e "require('./build/Release/rshl_native.node'); process.exit(0);" >nul 2>&1
if %errorlevel% equ 0 (
    echo  Native AVX2+OMP addon: ACTIVE
    echo  You are running at full performance.
    echo.
    goto :run_bench
)

:: ── Native not loaded — offer to build ───────────────────────────────────────
echo  ┌─────────────────────────────────────────────────────────┐
echo  │  Native addon not loaded ^(built for a different Node^)   │
echo  │                                                         │
echo  │  WITHOUT it:  Pure JS mode — accurate, moderate speed   │
echo  │  WITH    it:  AVX2+OMP    — 50-200x faster recall       │
echo  │               100,000 entries in under 8ms              │
echo  │                                                         │
echo  │  Building requires Visual Studio 2022 with:             │
echo  │    "Desktop development with C++" workload              │
echo  └─────────────────────────────────────────────────────────┘
echo.

set /p BUILD_CHOICE= Build native addon for full performance? [Y/N]:

if /i "%BUILD_CHOICE%"=="Y" goto :build_native
if /i "%BUILD_CHOICE%"=="YES" goto :build_native

echo.
echo  Running in pure JS mode. Results will still be accurate.
echo.
goto :run_bench

:build_native
echo.
echo  Checking for Visual Studio build tools...
where cl >nul 2>&1
if %errorlevel% neq 0 (
    :: Try to find vcvars64 and activate it
    set VCVARS=""
    for %%p in (
        "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
        "C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat"
        "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvars64.bat"
        "C:\Program Files (x86)\Microsoft Visual Studio\2019\Community\VC\Auxiliary\Build\vcvars64.bat"
        "C:\Program Files (x86)\Microsoft Visual Studio\2019\Professional\VC\Auxiliary\Build\vcvars64.bat"
    ) do if exist %%p set VCVARS=%%p

    if %VCVARS%=="" (
        echo.
        echo  Visual Studio 2022 not found.
        echo  Install from: https://visualstudio.microsoft.com/downloads/
        echo  Choose "Desktop development with C++" workload during install.
        echo.
        echo  Falling back to pure JS mode.
        echo.
        goto :run_bench
    )
    call %VCVARS% >nul 2>&1
)

echo  Installing node-addon-api...
call npm install --silent 2>nul

echo  Building native addon...
call npx node-gyp configure build 2>&1

if %errorlevel% neq 0 (
    echo.
    echo  Build failed. Running in pure JS mode.
    echo.
) else (
    echo.
    echo  Build successful — native AVX2+OMP now active.
    echo  You are running at full performance.
    echo.
)

:run_bench
echo  Starting benchmark... ^(60-90 seconds^)
echo.
node bench.js --save

echo.
echo  ================================================
echo   Done! Results saved to the reports\ folder.
echo   Share that JSON file to compare across machines.
echo  ================================================
echo.
pause
