@echo off
echo RSHL Personal Memory Engine - Benchmark
echo ========================================
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js not found. Install from https://nodejs.org
    pause
    exit /b 1
)

echo Installing dependencies...
call npm install --ignore-scripts --silent 2>nul

echo.
echo Detecting hardware capabilities...
echo (If native addon is already built, it will be used automatically)
echo.
node bench.js --save

echo.
echo ========================================
echo Done. Check the reports/ folder for your JSON result.
echo Share that file to compare machines.
pause
