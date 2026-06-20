@echo off
REM ============================================================
REM  RESTORE KAI FLEET TO LAST WORKING VERSION (v8.4.16)
REM
REM  What this does:
REM   - Clears the stale git lock left by a crashed AI tool
REM   - Backs up the CURRENT (Grok-edited) files first (reversible)
REM   - Restores ONLY the files Grok damaged back to the last
REM     committed working baseline
REM   - KEEPS oracle-gateway.mjs (it has your vitals fix)
REM   - KEEPS your lattice/brain (data\) and backups — untouched
REM
REM  Your memory (the lattice) is NOT affected by any of this.
REM ============================================================
cd /d C:\KAI
echo.

echo [1/4] Clearing stale git lock (from the crashed AI tool)...
if exist ".git\index.lock" del /f /q ".git\index.lock"
echo       Done.

echo.
echo [2/4] Backing up current files to _grok_backup (reversible)...
set BK=C:\KAI\_grok_backup_%date:~-4%%date:~4,2%%date:~7,2%
mkdir "%BK%" 2>nul
copy /y "C:\KAI\tools\oracle-discord\bots\leo.mjs" "%BK%\" >nul 2>nul
copy /y "C:\KAI\tools\oracle-discord\shared\openjarvis.mjs" "%BK%\" >nul 2>nul
copy /y "C:\KAI\tools\oracle-discord\bots\start-bot.mjs" "%BK%\" >nul 2>nul
copy /y "C:\KAI\tools\oracle-discord\bots\native-bot.mjs" "%BK%\" >nul 2>nul
copy /y "C:\KAI\tools\oracle-discord\index.mjs" "%BK%\" >nul 2>nul
copy /y "C:\KAI\tools\oracle-discord\shared\utils.mjs" "%BK%\" >nul 2>nul
copy /y "C:\KAI\tools\oracle-discord\ecosystem-manager.mjs" "%BK%\" >nul 2>nul
echo       Saved to %BK%

echo.
echo [3/4] Restoring Grok-damaged files to working baseline...
echo       (oracle-gateway.mjs is KEPT for your vitals fix)
git checkout HEAD -- "tools/oracle-discord/bots/leo.mjs"
git checkout HEAD -- "tools/oracle-discord/shared/openjarvis.mjs"
git checkout HEAD -- "tools/oracle-discord/bots/start-bot.mjs"
git checkout HEAD -- "tools/oracle-discord/bots/native-bot.mjs"
git checkout HEAD -- "tools/oracle-discord/index.mjs"
git checkout HEAD -- "tools/oracle-discord/shared/utils.mjs"
git checkout HEAD -- "tools/oracle-discord/ecosystem-manager.mjs"
echo       Done.

echo.
echo [4/4] Verifying leo.mjs parses cleanly...
node --check "C:\KAI\tools\oracle-discord\bots\leo.mjs" && echo       LEO OK - no syntax errors.

echo.
echo ============================================================
echo  RESTORE COMPLETE.
echo  Fleet code is back to working v8.4.16 (Grok's damage removed).
echo  Your vitals fix (oracle-gateway) and lattice/brain are kept.
echo.
echo  Next: run KAI-Start.bat
echo.
echo  If vitals act up, you can also restore oracle-gateway with:
echo    git checkout HEAD -- tools/oracle-discord/oracle-gateway.mjs
echo  Grok's old versions are saved in %BK% if ever needed.
echo ============================================================
pause
