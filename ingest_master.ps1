# KAI Universal Ingestor
# Scans the entire data directory for training material to hit 10k+ cells.

Write-Host "--- KAI UNIVERSAL INGEST ---" -ForegroundColor Cyan

$dataDir = "C:\KAI\data"
$files = Get-ChildItem -Path $dataDir -Recurse -Include *.txt, *.md -Exclude "test*", "*diagnostics*", "*audit*"

foreach ($f in $files) {
    Write-Host "Ingesting: $($f.Name)" -ForegroundColor Green
    ./target/release/kai.exe --ingest "$($f.FullName)" --region "Global" --batch-size 200
}

Write-Host "--- UNIVERSAL INGEST COMPLETE ---" -ForegroundColor Cyan
Write-Host "Re-launching Sovereign Dashboard..."
./target/release/kai.exe --oracle-server
