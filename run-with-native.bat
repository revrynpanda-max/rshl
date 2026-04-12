@echo off
echo RSHL Benchmark - WITH Native AVX2+OpenMP Acceleration
echo ======================================================
echo Requires: Visual Studio 2019 or 2022 (Community is fine)
echo           Node.js 16+
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js not found. Install from https://nodejs.org
    pause & exit /b 1
)

echo Installing dependencies...
call npm install --silent 2>nul

echo.
echo Building native addon (AVX2 + OpenMP)...
call npx node-gyp configure build 2>&1
if %errorlevel% neq 0 (
    echo.
    echo Native build failed. Falling back to pure JS mode.
    echo To fix: install Visual Studio 2022 Community with "Desktop development with C++"
    echo.
    node bench.js --save
) else (
    echo Native build successful.
    echo.
    node bench.js --native --save
)

echo.
echo Check reports/ folder for your JSON result file.
pause
