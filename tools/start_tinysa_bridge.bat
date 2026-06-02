@echo off
title TinySA Ultra - KAI Sensory Bridge
echo ========================================================
echo   KAI Sovereign Mode - TinySA Ultra Hardware Bridge
echo ========================================================
echo.
echo NOTE: If you have tinySA-App (QtTinySA) running, you MUST
echo close it first, otherwise this script cannot connect to COM6.
echo.
echo Launching Python Bridge Script...
echo.
python C:\KAI\tools\tinysa_bridge.py
pause
