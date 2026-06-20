# =====================================================================
#  Restore-Codex-Baseline.ps1
#  Restores the gutted fleet source files to the Codex-documented
#  working baseline (git HEAD / v8.4.16), backs up current versions
#  first, then reinstalls dependencies (incl. better-sqlite3).
#
#  KEEPS (not reverted): oracle-gateway.mjs (vitals fix),
#  kai-coder-toolserver.mjs, tools/system-auditor.mjs, package.json
#  (better-sqlite3 + @google/genai), leo.mjs, native-bot.mjs, kaiverse/,
#  Modelfiles, and all your .bat launchers.
# =====================================================================

$ErrorActionPreference = "Stop"
$repo = "C:\KAI"
$od   = "C:\KAI\tools\oracle-discord"
Set-Location $repo

# --- The 29 gutted files to restore to baseline ---
$revert = @(
  "tools/oracle-discord/shared/openjarvis.mjs",
  "tools/oracle-discord/ecosystem-manager.mjs",
  "tools/oracle-discord/bots/kai.mjs",
  "tools/oracle-discord/bots/start-bot.mjs",
  "tools/oracle-discord/radio/radio-dj.mjs",
  "tools/oracle-discord/shared/kai-coder-agent.mjs",
  "tools/oracle-discord/radio/music-player.mjs",
  "tools/oracle-discord/shared/lattice-bridge.mjs",
  "tools/oracle-discord/shared/kai-dream.mjs",
  "tools/oracle-discord/shared/simulation.mjs",
  "tools/oracle-discord/shared/failure-tracker.mjs",
  "tools/oracle-discord/index.mjs",
  "tools/oracle-discord/radio/tts.mjs",
  "tools/oracle-discord/shared/performance-monitor.mjs",
  "tools/oracle-discord/radio/playlists.mjs",
  "tools/oracle-discord/shared/channel-rules.mjs",
  "tools/oracle-discord/shared/hours.mjs",
  "tools/oracle-discord/shared/biographies.mjs",
  "tools/oracle-discord/shared/oracle-pipeline.mjs",
  "tools/oracle-discord/shared/ipc.mjs",
  "tools/oracle-discord/scripts/ingest-whitepaper.mjs",
  "tools/oracle-discord/shared/sentinel.mjs",
  "tools/oracle-discord/shared/daily-learning.mjs",
  "tools/oracle-discord/shared/utils.mjs",
  "tools/oracle-discord/shared/identities.mjs",
  "tools/oracle-discord/shared/project-awareness.mjs",
  "tools/oracle-discord/scripts/setup-models.mjs",
  "tools/oracle-discord/prime-awareness.mjs",
  "tools/oracle-discord/shared/laws-of-kai.mjs"
)

# --- Step 0: clear any stale git lock ---
$lock = "C:\KAI\.git\index.lock"
if (Test-Path $lock) { Remove-Item $lock -Force; Write-Host "[Lock] Removed stale .git/index.lock" -ForegroundColor Yellow }

# --- Step 1: back up CURRENT versions before touching anything ---
$stamp  = Get-Date -Format "yyyyMMdd-HHmmss"
$backup = "C:\KAI\_ai_damage_backup_$stamp"
New-Item -ItemType Directory -Force -Path $backup | Out-Null
Write-Host "[Backup] Saving current versions to $backup" -ForegroundColor Cyan
foreach ($f in $revert) {
  $src = Join-Path $repo $f
  if (Test-Path $src) {
    $dest = Join-Path $backup ($f -replace '/', '\')
    New-Item -ItemType Directory -Force -Path (Split-Path $dest -Parent) | Out-Null
    Copy-Item $src $dest -Force
  }
}
Write-Host "[Backup] Done. Nothing is lost - current versions are safe here." -ForegroundColor Green

# --- Step 2: restore the gutted files to the Codex baseline (HEAD) ---
Write-Host "[Restore] Reverting 29 gutted files to baseline v8.4.16..." -ForegroundColor Cyan
foreach ($f in $revert) {
  git checkout HEAD -- $f
  Write-Host "  restored $f"
}
Write-Host "[Restore] All gutted files restored to Codex baseline." -ForegroundColor Green

# --- Step 3: reinstall dependencies (gets better-sqlite3 + the rest) ---
Set-Location $od
Write-Host "[Deps] Running npm install (this fetches better-sqlite3)..." -ForegroundColor Cyan
npm install

Write-Host ""
Write-Host "=====================================================" -ForegroundColor Green
Write-Host " RESTORE COMPLETE." -ForegroundColor Green
Write-Host " Backup of pre-restore versions: $backup" -ForegroundColor Green
Write-Host " Now start the fleet:  .\run-oracle-discord.ps1" -ForegroundColor Green
Write-Host "=====================================================" -ForegroundColor Green
