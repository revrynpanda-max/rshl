param(
    [switch]$Force,      # Allow creating even if a backup for today (or <24h) already exists. For manual or emergency "something happened".
    [switch]$PruneOnly   # Only run the Archive Tribunal pruning, do not create a new backup.
)

$sourceDir = "C:\KAI\data"
$backupRoot = "C:\KAI_Secure_Backups"

if ($PruneOnly) {
    Write-Host "[KAI Backup] PruneOnly mode - running Archive Tribunal only (no new snapshot)."
} else {
    $timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
    $destDir = Join-Path $backupRoot $timestamp

    # Create the secure backup folder if it doesn't exist
    if (-not (Test-Path $destDir)) {
        New-Item -ItemType Directory -Force -Path $destDir | Out-Null
    }

    # --- Rate limit: at most 1 per day (or ~24h) unless -Force or manual trigger ---
    $todayPrefix = Get-Date -Format "yyyy-MM-dd"
    $existingToday = Get-ChildItem -Path $backupRoot -Directory -Force | Where-Object {
        $_.Name -like "$todayPrefix*" -and $_.Name -ne "Archive_Trash"
    }
    if ($existingToday -and -not $Force) {
        Write-Host "[KAI Backup] A backup for today already exists ($($existingToday.Name)). Skipping creation (at most 1/day by default)."
        Write-Host "             Use -Force for manual/emergency backup, or let the 24h / end-of-shift watcher decide."
        # Still run pruning below, then exit
    } else {
        # Optional 24h guard (in addition to daily prefix)
        $latest = Get-ChildItem -Path $backupRoot -Directory -Force | Where-Object { $_.Name -ne "Archive_Trash" } | Sort-Object CreationTime -Descending | Select-Object -First 1
        if ($latest -and -not $Force) {
            $ageHours = ((Get-Date) - $latest.CreationTime).TotalHours
            if ($ageHours -lt 23) {
                Write-Host "[KAI Backup] Last backup was only $([math]::Round($ageHours,1)) hours ago (<24h). Skipping (use -Force for manual)."
                # fall through to pruning only
            } else {
                Write-Host "[KAI Backup] Starting secure backup to $destDir..."

                # Array of critical files to backup (the absolute core of KAI's brain)
                # These are the persistent cognitive state produced by src/persistence.rs (compact cells + meta + mind + texts).
                $criticalFiles = @(
                    "kai-cells.bin.zst",
                    "kai-meta.json",
                    "kai-meta.json.zst",
                    "kai-texts.bin",
                    "kai-mind.json",
                    "..\tools\oracle-discord\.env"
                )

                foreach ($file in $criticalFiles) {
                    $srcPath = Join-Path $sourceDir $file
                    if (Test-Path $srcPath) {
                        $destFile = Join-Path $destDir (Split-Path $srcPath -Leaf)
                        Copy-Item -Path $srcPath -Destination $destFile -Force
                        Write-Host "  -> Backed up: $file"
                    } else {
                        Write-Host "  -> Skipped (not found): $file"
                    }
                }
            }
        } else {
            Write-Host "[KAI Backup] Starting secure backup to $destDir..."

            $criticalFiles = @(
                "kai-cells.bin.zst",
                "kai-meta.json",
                "kai-meta.json.zst",
                "kai-texts.bin",
                "kai-mind.json",
                "..\tools\oracle-discord\.env"
            )

            foreach ($file in $criticalFiles) {
                $srcPath = Join-Path $sourceDir $file
                if (Test-Path $srcPath) {
                    $destFile = Join-Path $destDir (Split-Path $srcPath -Leaf)
                    Copy-Item -Path $srcPath -Destination $destFile -Force
                    Write-Host "  -> Backed up: $file"
                } else {
                    Write-Host "  -> Skipped (not found): $file"
                }
            }
        }
    }
}

# --- Biological Decay Cycle (Archive Tribunal) - ALWAYS RUN ---
# Prunes according to your 7-day + 3-day rule, no matter how the backup was triggered.
# This is the scheduling for removing older backups: it runs on every backup invocation (and can be called with -PruneOnly).
# Future: the watcher can also call with -PruneOnly on startup / 9AM / hourly if desired.

# --- Biological Decay Cycle (Archive Tribunal) ---
$archiveTrash = Join-Path $backupRoot "Archive_Trash"
if (-not (Test-Path $archiveTrash)) {
    New-Item -ItemType Directory -Force -Path $archiveTrash | Out-Null
}

# 1. Annihilation (Recycle): Destroy data in the Trash that is older than 3 days after scoring
$THRESHOLD = 0.5
$engine = "http://127.0.0.1:3334/api/judge-snapshot"
foreach ($trash in (Get-ChildItem $archiveTrash -Directory | Where-Object { $_.CreationTime -lt (Get-Date).AddDays(-3) })) {
    $verdict = "annihilate"; $score = $null
    try {
        $resp = Invoke-RestMethod -Uri $engine -Method POST -TimeoutSec 30 `
            -ContentType "application/json" -Body (@{ path = $trash.FullName } | ConvertTo-Json)
        $score = $resp.score; $verdict = $resp.verdict
    } catch {
        # Engine unreachable -> SAFE FALLBACK: keep current behavior (annihilate >3d), log it.
        Write-Host "[KAI Judgment] Engine unavailable; default annihilation for $($trash.Name)."
        $verdict = "annihilate"
    }
    if ($verdict -eq "reprieve") {
        New-Item -ItemType File -Path (Join-Path $trash.FullName "REPRIEVED.flag") -Force | Out-Null
        Write-Host "[KAI Judgment] REPRIEVED ($([math]::Round($score,3))): $($trash.Name)"
    } else {
        Remove-Item $trash.FullName -Recurse -Force
        Write-Host "[KAI Judgment] Annihilated ($(if($null -ne $score){[math]::Round($score,3)}else{'no-score'})): $($trash.Name)"
    }
}

# 2. Decay (Judgment): Move backups older than 7 days into the Archive_Trash bin
$oldBackups = Get-ChildItem -Path $backupRoot -Directory | Where-Object { $_.Name -ne "Archive_Trash" -and $_.CreationTime -lt (Get-Date).AddDays(-7) }
foreach ($old in $oldBackups) {
    $dest = Join-Path $archiveTrash $old.Name
    Move-Item -Path $old.FullName -Destination $dest -Force
    Write-Host "[KAI Backup] Sent to Archive Tribunal (decaying in 3 days): $($old.Name)"
}

Write-Host "[KAI Backup] Complete! Brain securely archived."
