$sourceDir = "C:\KAI\data"
$backupRoot = "C:\KAI_Secure_Backups"
$timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$destDir = Join-Path $backupRoot $timestamp

# Create the secure backup folder if it doesn't exist
if (-not (Test-Path $destDir)) {
    New-Item -ItemType Directory -Force -Path $destDir | Out-Null
}

Write-Host "[KAI Backup] Starting secure backup to $destDir..."

# Array of critical files to backup (the absolute core of KAI's brain)
$criticalFiles = @(
    "kai-cells.bin.zst",
    "kai-meta.json",
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

# --- Biological Decay Cycle (Archive Tribunal) ---
$archiveTrash = Join-Path $backupRoot "Archive_Trash"
if (-not (Test-Path $archiveTrash)) {
    New-Item -ItemType Directory -Force -Path $archiveTrash | Out-Null
}

# 1. Annihilation (Recycle): Destroy data in the Trash that is older than 3 days
$trashedBackups = Get-ChildItem -Path $archiveTrash -Directory | Where-Object { $_.CreationTime -lt (Get-Date).AddDays(-3) }
foreach ($trash in $trashedBackups) {
    Remove-Item -Path $trash.FullName -Recurse -Force
    Write-Host "[KAI Archive] Annihilated (recycled into energy): $($trash.Name)"
}

# 2. Decay (Judgment): Move backups older than 7 days into the Archive_Trash bin
$oldBackups = Get-ChildItem -Path $backupRoot -Directory | Where-Object { $_.Name -ne "Archive_Trash" -and $_.CreationTime -lt (Get-Date).AddDays(-7) }
foreach ($old in $oldBackups) {
    $dest = Join-Path $archiveTrash $old.Name
    Move-Item -Path $old.FullName -Destination $dest -Force
    Write-Host "[KAI Backup] Sent to Archive Tribunal (decaying in 3 days): $($old.Name)"
}

Write-Host "[KAI Backup] Complete! Brain securely archived."
