@echo off
setlocal

set CUDA_PATH=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.6
set NVCC="%CUDA_PATH%\bin\nvcc.exe"

if not exist %NVCC% (
    echo ERROR: nvcc not found at %CUDA_PATH%\bin\nvcc.exe
    echo Install CUDA Toolkit 12.x from developer.nvidia.com
    exit /b 1
)

echo RSHL CUDA benchmark build
echo   nvcc: %NVCC%
echo   arch: sm_89 (Ada Lovelace / RTX 4050)
echo.

cd /d "%~dp0"
%NVCC% -O2 -arch=sm_89 rshl_cuda_bench.cu -lcublas -o rshl_cuda_bench.exe 2>&1

if errorlevel 1 (
    echo.
    echo Build FAILED. Common fixes:
    echo   - Ensure Visual Studio 2022 C++ tools are installed
    echo   - Ensure CUDA Toolkit 12.x is installed
    echo   - Try: -arch=sm_86 if sm_89 not supported
    exit /b 1
)

echo.
echo Build OK: rshl_cuda_bench.exe
echo Run standalone:   rshl_cuda_bench.exe
echo Run via bench:    cd .. ^&^& node bench.js
