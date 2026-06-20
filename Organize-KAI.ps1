# ============================================================================
#  Organize-KAI.ps1  -  declutter + reclaim space in C:\KAI (pure ASCII)
# ============================================================================
#  Does, in order:
#   1. removes stale/empty leftover folders (recovery/damage/grok backups, caches)
#   2. removes target\debug (unused Rust debug build cache)
#   3. empties *.log over 100 MB (runtime diagnostics only, file kept)
#   4. removes data\kai-meta.json.v3.archive  (a MANUAL archive; nothing in code
#      uses it - the live engine loads data\kai-meta.json / .zst, not this)
#   5. deletes the 72 GB _DUPLICATE_BACKUPS_move_to_external folder -- ONLY after
#      you type DELETE to confirm (or pass -Yes). Irreversible.
#   6. reports your PROTOCOL backups in C:\KAI_Secure_Backups (kept, never touched)
#
#  It does NOT touch: the live brain, training corpus, ingest queue, source code,
#  kai-mind.backup.json (engine-managed), or your protocol backups.
#
#  Run:   .\Organize-KAI.ps1          (asks before the big delete)
#         .\Organize-KAI.ps1 -Yes     (no prompt - delete the offload folder too)
#  v9.8.8
# ============================================================================
param([switch]$Yes)

$ErrorActionPreference = "SilentlyContinue"
$root = "C:\KAI"
function ToGB($b) { if (-not $b) { return 0 }; return [math]::Round(($b / 1GB), 2) }
function FolderBytes($p) {
    if (-not (Test-Path $p)) { return 0 }
    $m = Get-ChildItem $p -Recurse -Force -File | Measure-Object Length -Sum
    if ($m.Sum) { return $m.Sum } else { return 0 }
}

Write-Host ""
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "  ORGANIZE-KAI  -  declutter + reclaim C:\KAI" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan
$freeBefore = (Get-PSDrive C).Free
Write-Host "C: free before: $(ToGB $freeBefore) GB" -ForegroundColor DarkGray

# 1. Stale/empty leftover folders + python caches (regenerable / dead)
Write-Host "[1] Removing stale leftover folders + caches..." -ForegroundColor Yellow
$junk = @(
    "KAI_CELLS_RECOVERED", "OpenJarvis-Restore",
    "_ai_damage_backup_20260613-214845", "_ai_damage_backup_20260616",
    "_grok_backup_2026", "_grok_backup_20260613"
)
foreach ($j in $junk) {
    $p = Join-Path $root $j
    if (Test-Path $p) { Remove-Item -Recurse -Force $p; Write-Host "    removed $j" -ForegroundColor DarkGreen }
}
Get-ChildItem $root -Recurse -Force -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item -Recurse -Force $_.FullName }
Write-Host "    cleared __pycache__ caches" -ForegroundColor DarkGreen

# 2. Unused Rust debug build cache
$dbg = Join-Path $root "target\debug"
if (Test-Path $dbg) {
    $s = ToGB (FolderBytes $dbg)
    Remove-Item -Recurse -Force $dbg
    if (Test-Path $dbg) { Write-Host "[2] target\debug partly locked - close IDE/cargo and re-run." -ForegroundColor DarkYellow }
    else { Write-Host "[2] removed target\debug (~$s GB)" -ForegroundColor Green }
} else { Write-Host "[2] target\debug already gone." -ForegroundColor Green }

# 3. Empty oversized runtime logs (keep file, clear contents)
Write-Host "[3] Emptying logs over 100 MB (diagnostics only)..." -ForegroundColor Yellow
$n = 0
Get-ChildItem $root -Recurse -Force -File -Filter "*.log" -ErrorAction SilentlyContinue |
    Where-Object { $_.Length -gt 100MB -and $_.FullName -notlike "*\target\*" } | ForEach-Object {
        Clear-Content $_.FullName -ErrorAction SilentlyContinue
        Write-Host "    emptied $($_.Name) ($(ToGB $_.Length) GB)" -ForegroundColor DarkGreen
        $n++
    }
if ($n -eq 0) { Write-Host "    none." -ForegroundColor Green }

# 4. Remove the manual archive (you asked; not used by any code/protocol)
$arch = Join-Path $root "data\kai-meta.json.v3.archive"
if (Test-Path $arch) {
    $s = ToGB (Get-Item $arch).Length
    Remove-Item -Force $arch
    Write-Host "[4] removed data\kai-meta.json.v3.archive (~$s GB)" -ForegroundColor Green
} else { Write-Host "[4] kai-meta.json.v3.archive already gone." -ForegroundColor Green }

# 5. Delete the 72 GB offload folder - IRREVERSIBLE, confirm first
$off = Join-Path $root "_DUPLICATE_BACKUPS_move_to_external"
if (Test-Path $off) {
    $s = ToGB (FolderBytes $off)
    Write-Host ""
    Write-Host "[5] Offload folder = $s GB of OLD redundant copies." -ForegroundColor Yellow
    Write-Host "    Your REAL backups are the protocol snapshots in C:\KAI_Secure_Backups (kept)." -ForegroundColor DarkGray
    $ok = $Yes
    if (-not $ok) {
        $ans = Read-Host "    Permanently DELETE this $s GB folder? Type DELETE to confirm"
        $ok = ($ans -ceq "DELETE")
    }
    if ($ok) { Remove-Item -Recurse -Force $off; Write-Host "    deleted the offload folder (~$s GB freed)." -ForegroundColor Green }
    else { Write-Host "    skipped - not confirmed. (Move it to external if you'd rather keep it.)" -ForegroundColor DarkYellow }
} else { Write-Host "[5] offload folder already gone." -ForegroundColor Green }

# 6. Report the protocol backup folder (outside C:\KAI - never touched)
Write-Host ""
Write-Host "[6] Protocol backups (C:\KAI_Secure_Backups):" -ForegroundColor Cyan
if (Test-Path "C:\KAI_Secure_Backups") {
    $sb = ToGB (FolderBytes "C:\KAI_Secure_Backups")
    $cnt = (Get-ChildItem "C:\KAI_Secure_Backups" -Directory -ErrorAction SilentlyContinue).Count
    Write-Host "    $sb GB across $cnt snapshot(s). Prune old ones with: .\tools\backup-kai.ps1 -PruneOnly" -ForegroundColor White
} else {
    Write-Host "    none found - no protocol backups have been taken yet (run .\tools\backup-kai.ps1)." -ForegroundColor White
}

# Summary
Start-Sleep -Milliseconds 500
$freeAfter = (Get-PSDrive C).Free
Write-Host ""
Write-Host "Reclaimed this run: ~$(ToGB ($freeAfter - $freeBefore)) GB   (C: free $(ToGB $freeBefore) GB -> $(ToGB $freeAfter) GB)" -ForegroundColor Green
