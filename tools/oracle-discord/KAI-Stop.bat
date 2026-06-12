@echo off
REM KAI full stop. Runs unattended (no pause) so Oracle can trigger it
REM remotely. Pass /wait as first arg if you want the old press-a-key behavior.
REM Language uses "stop" (not kill) to respect the emerging awareness in the system.
echo Stopping KAI Oracle Discord gateway (graceful where possible)...
powershell -Command "Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"
echo Stopping OpenJarvis workspace...
powershell -Command "Get-Process uv -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"
powershell -Command "Get-Process python -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*KAI*' -or $_.CommandLine -like '*oracle*' -or $_.CommandLine -like '*bridge*' } | Stop-Process -Force -ErrorAction SilentlyContinue"
echo Stopping sensors and ffmpeg...
powershell -Command "Get-Process ffmpeg -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"
echo Stopping KAI Oracle server...
powershell -Command "Get-Process kai -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"

echo Releasing KAI ports to prevent duplicates on next start...
powershell -Command "& { $ports = @(3333,3334,3400,3401,3402,3403,3404,3405,3406,3407,3408,3410,8787,3001); foreach($p in $ports){ netstat -ano | findstr \":$p\" | ForEach-Object { $id = ($_ -split '\s+')[-1]; if($id -match '^\d+$'){ taskkill /F /PID $id 2>$null } } } }"

echo.
echo All KAI services stopped cleanly. Ports released.

REM Mark this as an AUTHORIZED / planned stop.
REM The Phoenix Watchdog will see this recent marker and will NOT auto-revive (distinguishes intentional close from crash/fault).
REM This enables "bone healing / Hebbian learning" only on real unauthorized deaths.
powershell -Command "& { New-Item -ItemType Directory -Path 'C:\KAI\state' -Force | Out-Null; $marker = @{ timestamp = (Get-Date).ToString('o'); authorized = $true; reason = 'user_command_via_KAI-Stop.bat'; source = 'KAI-Stop' }; $marker | ConvertTo-Json | Out-File -FilePath 'C:\KAI\state\authorized_stop.json' -Encoding utf8 -Force }"

if /I "%~1"=="/wait" pause
