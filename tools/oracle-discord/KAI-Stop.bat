@echo off
echo Stopping KAI Oracle Discord gateway...
taskkill /F /IM node.exe /T 2>nul
echo Stopping OpenJarvis workspace...
taskkill /F /IM uv.exe /T 2>nul
taskkill /F /IM python.exe /T 2>nul
echo Stopping KAI Oracle server...
taskkill /F /IM kai.exe /T 2>nul
echo.
echo All KAI services stopped.
pause
