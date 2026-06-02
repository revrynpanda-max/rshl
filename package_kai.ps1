$ZipName = "KAI_Cloud_Pod.zip"
$SourceDir = "C:\KAI"
$TempDir = "$env:TEMP\KAI_Pod_Build"

Write-Host "Cleaning up old builds..."
if (Test-Path $TempDir) { Remove-Item -Recurse -Force $TempDir }
if (Test-Path $ZipName) { Remove-Item -Force $ZipName }

Write-Host "Creating staging directory structure..."
New-Item -ItemType Directory -Path "$TempDir\src" | Out-Null
New-Item -ItemType Directory -Path "$TempDir\data\training_corpus" | Out-Null

Write-Host "Copying Source Code..."
Copy-Item -Path "$SourceDir\src\*" -Destination "$TempDir\src" -Recurse
Copy-Item -Path "$SourceDir\Cargo.toml" -Destination "$TempDir"

Write-Host "Copying Dataset and Memory Lattice..."
Copy-Item -Path "$SourceDir\data\training_corpus\*" -Destination "$TempDir\data\training_corpus" -Recurse
Copy-Item -Path "$SourceDir\data\kai-cells.bin.zst" -Destination "$TempDir\data"
Copy-Item -Path "$SourceDir\data\kai-meta.json" -Destination "$TempDir\data"
Copy-Item -Path "$SourceDir\data\semantic_dict.json" -Destination "$TempDir\data"

if (Test-Path "$SourceDir\data\ternary_mlp.bin") {
    Write-Host "Copying existing MLP weights..."
    Copy-Item -Path "$SourceDir\data\ternary_mlp.bin" -Destination "$TempDir\data"
}

Write-Host "Zipping everything up (this may take a minute due to the 1GB lattice file)..."
Compress-Archive -Path "$TempDir\*" -DestinationPath "$SourceDir\$ZipName" -CompressionLevel Optimal

Write-Host "Cleaning up staging directory..."
Remove-Item -Recurse -Force $TempDir

Write-Host ""
Write-Host "=========================================================="
Write-Host " SUCCESS! Cloud Pod created at: $SourceDir\$ZipName"
Write-Host "=========================================================="
