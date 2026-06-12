@echo off
REM KAI full start. Runs unattended (no pause) so Oracle can trigger it
REM remotely. Pass /wait as first arg for the old press-a-key behavior.
REM Ensures no duplicated ports before starting (sensors, phone bridge on 8787, lattice, agents).
set OPENJARVIS_CONFIG=C:\KAI\OpenJarvis-main\configs\openjarvis\config.toml
cd /d C:\KAI\tools\oracle-discord

echo Releasing any stuck KAI ports before start (prevents duplicates on phone 8787 / lattice / agents)...
powershell -Command "& { $ports = @(3333,3334,3400,3401,3402,3403,3404,3405,3406,3407,3408,3410,8787,3001); foreach($p in $ports){ netstat -ano | findstr \":$p\" | ForEach-Object { $id = ($_ -split '\s+')[-1]; if($id -match '^\d+$'){ taskkill /F /PID $id 2>$null } } } }"

powershell.exe -ExecutionPolicy Bypass -NoProfile -File "run-oracle-discord.ps1"
if /I "%~1"=="/wait" pause
