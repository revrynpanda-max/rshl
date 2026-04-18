@echo off
title RSHL Benchmark - Full Native Build
color 0A
cls

echo.
echo  ================================================
echo   RSHL - Build Native AVX2+OMP + Run Benchmark
echo  ================================================
echo  This builds the C++ addon for maximum performance.
echo  Requires: Node.js 16+  ^|  Visual Studio 2022
echo            with "Desktop development with C++" workload
echo.

:: ── Check Node.js ────────────────────────────────────────────────────────────
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Node.js not found.
    echo  Download from: https://nodejs.org  ^(LTS^)
    pause & exit /b 1
)

for /f "tokens=*" %%v in ('node -e "process.stdout.write(process.version)"') do set NODE_VER=%%v
echo  Node.js %NODE_VER% found.
echo.

:: ── Find and activate VS build tools ─────────────────────────────────────────
where cl >nul 2>&1
if %errorlevel% neq 0 (
    set VCVARS=""
    for %%p in (
        "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
        "C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat"
        "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvars64.bat"
        "C:\Program Files (x86)\Microsoft Visual Studio\2019\Community\VC\Auxiliary\Build\vcvars64.bat"
        "C:\Program Files (x86)\Microsoft Visual Studio\2019\Professional\VC\Auxiliary\Build\vcvars64.bat"
    ) do if exist %%p set VCVARS=%%p

    if %VCVARS%=="" (
        echo  ERROR: Visual Studio with C++ workload not found.
        echo.
        echo  Install from: https://visualstudio.microsoft.com/downloads/
        echo  During setup choose: "Desktop development with C++"
        echo.
        echo  Falling back to pure JS mode...
        echo.
        goto :run_bench
    )
    call %VCVARS% >nul 2>&1
    echo  Visual Studio build tools activated.
)

:: ── Build native addon ────────────────────────────────────────────────────────
echo  Installing dependencies...
call npm install --silent 2>nul

echo  Building native AVX2+OMP addon...
call npx node-gyp configure build 2>&1

if %errorlevel% neq 0 (
    echo.
    echo  Build failed. Running in pure JS mode.
    echo.
) else (
    echo.
    echo  Build successful — native AVX2+OMP active.
    echo  You are running at full performance ^(50-200x faster recall^).
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
