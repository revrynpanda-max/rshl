@echo off
REM Master fleet relaunch — used by Phoenix watchdog auto-heal and manual recovery.
cd /d C:\KAI
powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -NoProfile -File "C:\KAI\Start-KAI.ps1"