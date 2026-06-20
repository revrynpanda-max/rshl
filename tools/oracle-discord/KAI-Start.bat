@echo off
set OPENJARVIS_CONFIG=C:\KAI\OpenJarvis-main\configs\openjarvis\config.toml
cd /d C:\KAI\tools\oracle-discord
powershell.exe -ExecutionPolicy Bypass -File "run-oracle-discord.ps1"
pause
