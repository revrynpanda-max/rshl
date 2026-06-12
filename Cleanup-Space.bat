@echo off
REM ============================================================
REM  KAI SAFE DISK CLEANUP
REM  Removes ONLY confirmed-safe waste. Frees ~22 GB.
REM  Does NOT touch: the lattice (data/), source (src/), the
REM  release binary, models, or any backups.
REM  Run this any time C: gets tight.
REM ============================================================
echo.
echo Stopping KAI first is recommended (so files aren't locked).
echo If KAI is running, close this, run KAI-Stop.bat, then re-run.
echo.
pause

echo.
echo [1/5] Deleting target\debug (Rust debug build, ~21 GB)...
echo       The system runs target\release\kai.exe — this is safe.
echo       Next 'cargo build --release' is unaffected (release kept).
if exist "C:\KAI\target\debug" rmdir /s /q "C:\KAI\target\debug"
echo       Done.

echo.
echo [2/5] Clearing old scratch debug files (logs, frames, dumps)...
del /q "C:\KAI\scratch\*.log" 2>nul
del /q "C:\KAI\scratch\debug_output*.txt" 2>nul
del /q "C:\KAI\scratch\camera_*_frame.jpg" 2>nul
del /q "C:\KAI\scratch\*.out.log" 2>nul
del /q "C:\KAI\scratch\*.err.log" 2>nul
echo       Done.

echo.
echo [3/5] Trimming oversized ecosystem logs (keeps the folder, clears bulk)...
if exist "C:\KAI\logs\ecosystem.log" (
  echo. > "C:\KAI\logs\ecosystem.log"
)
if exist "C:\KAI\tools\oracle-discord\logs\ecosystem.log" (
  echo. > "C:\KAI\tools\oracle-discord\logs\ecosystem.log"
)
echo       Done.

echo.
echo [4/5] Removing .bak / truncated backup junk in oracle-discord...
del /q /s "C:\KAI\tools\oracle-discord\*.bak.truncated-*" 2>nul
del /q /s "C:\KAI\tools\oracle-discord\bots\*.bak.*" 2>nul
del /q /s "C:\KAI\tools\oracle-discord\shared\*.bak.*" 2>nul
echo       Done.

echo.
echo [5/5] Removing the stray path-bug folder if present...
if exist "C:\KAI\C:" rmdir /s /q "C:\KAI\C:" 2>nul
echo       Done.

echo.
echo ============================================================
echo  SAFE CLEANUP COMPLETE — roughly 22 GB freed.
echo.
echo  OPTIONAL bigger wins (only if you're sure):
echo   - models\BitNet (8.8 GB): delete ONLY if BitNet weight
echo     extraction into the lattice is finished. If unsure, keep it.
echo   - models\Phi-3-mini-4k-instruct-q4.gguf (2.3 GB): delete
echo     ONLY if you don't use Phi-3 as a local fallback model.
echo   - C:\KAI_Secure_Backups and KAI_CELLS_SAFE_BACKUP_*
echo     (3.5 GB each): your lattice safety copies. Move to an
echo     external/D: drive rather than deleting.
echo ============================================================
pause
