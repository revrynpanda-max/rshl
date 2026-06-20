# ============================================================================
#  Reclaim-Space.ps1  -  safe disk cleanup for C:\KAI
# ============================================================================
#  Automatic (safe, regenerable / non-data only):
#    - deletes target\debug      (unused Rust DEBUG build cache; the system runs
#                                 target\release and never touches debug)
#    - empties *.log over 100 MB (file kept, contents cleared; logs are runtime
#                                 diagnostics, NOT learned data)
#  Report-only (never deleted): the 72 GB offload folder + the kept data backups.
#  It does NOT touch the brain, the training corpus, or the ingest queue.
#  Run:   .\Reclaim-Space.ps1
#  v9.8.7
# ============================================================================

$ErrorActionPreference = "SilentlyContinue"
$root = "C:\KAI"

function ToGB($bytes) { return [math]::Round(($bytes / 1GB), 1) }
function FolderBytes($p) {
    if (-not (Test-Path $p)) { return 0 }
    $m = Get-ChildItem $p -Recurse -Force -File | Measure-Object Length -Sum
    if ($m.Sum) { return $m.Sum } else { return 0 }
}

Write-Host ""
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "  RECLAIM-SPACE  -  safe cleanup of C:\KAI" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan

$freeBefore = (Get-PSDrive C).Free
Write-Host "C: free before: $(ToGB $freeBefore) GB" -ForegroundColor DarkGray

# 1. Delete the unused debug build cache (regenerable; never used at runtime)
$dbg = Join-Path $root "target\debug"
if (Test-Path $dbg) {
    $sz = ToGB (FolderBytes $dbg)
    Write-Host "[1] Deleting target\debug ($sz GB of unused debug build cache)..." -ForegroundColor Yellow
    Remove-Item -Recurse -Force $dbg
    if (Test-Path $dbg) {
        Write-Host "    Some files were locked - close any IDE/cargo and re-run." -ForegroundColor DarkYellow
    } else {
        Write-Host "    Reclaimed ~$sz GB." -ForegroundColor Green
    }
} else {
    Write-Host "[1] target\debug already gone - nothing to do." -ForegroundColor Green
}

# 2. Empty oversized logs (keep the file, clear contents). Runtime logs only.
Write-Host "[2] Emptying log files over 100 MB (diagnostics only, no learned data)..." -ForegroundColor Yellow
$logsTrimmed = 0
Get-ChildItem $root -Recurse -Force -File -Filter *.log -ErrorAction SilentlyContinue |
    Where-Object { $_.Length -gt 100MB -and $_.FullName -notlike "*\target\*" } | ForEach-Object {
        $lsz = ToGB $_.Length
        Clear-Content $_.FullName -ErrorAction SilentlyContinue
        Write-Host "    emptied $($_.FullName) ($lsz GB)" -ForegroundColor DarkGreen
        $logsTrimmed++
    }
if ($logsTrimmed -eq 0) { Write-Host "    No oversized logs." -ForegroundColor Green }

# 3. Report-only: big items that need YOUR decision (never auto-deleted)
Write-Host ""
Write-Host "[3] Needs YOUR decision (NOT touched by this script):" -ForegroundColor Cyan
$offload = Join-Path $root "_DUPLICATE_BACKUPS_move_to_external"
if (Test-Path $offload) {
    $osz = ToGB (FolderBytes $offload)
    Write-Host "    - Offload folder: $osz GB  -> drag to an EXTERNAL drive, then delete." -ForegroundColor White
    Write-Host "      $offload" -ForegroundColor DarkGray
}
foreach ($bak in @("data\kai-meta.json.v3.archive", "data\kai-mind.backup.json")) {
    $p = Join-Path $root $bak
    if (Test-Path $p) {
        $bsz = ToGB (Get-Item $p).Length
        Write-Host "    - Kept backup: $bsz GB ($bak) - move to external too if not needed on C:." -ForegroundColor White
    }
}

# Summary
Start-Sleep -Milliseconds 500
$freeAfter = (Get-PSDrive C).Free
$gained = ToGB ($freeAfter - $freeBefore)
Write-Host ""
Write-Host "Reclaimed this run: ~$gained GB   (C: free $(ToGB $freeBefore) GB -> $(ToGB $freeAfter) GB)" -ForegroundColor Green
Write-Host "Move the offload folder + kept backups to external for the big win (~90 GB total)." -ForegroundColor Yellow
