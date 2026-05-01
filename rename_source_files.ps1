# KAI File Renaming Script
$TargetDir = "C:\KAI\src-CLI code\src"

Write-Host "Renaming files in $TargetDir..." -ForegroundColor Cyan

Get-ChildItem -Path $TargetDir -Recurse | ForEach-Object {
    $oldName = $_.Name
    $newName = $oldName -replace "KAI", "KAI" -replace "KAI", "kai" -replace "Geometric Intelligence", "GeometricIntelligence"
    
    if ($newName -ne $oldName) {
        $newPath = Join-Path $_.Parent.FullName $newName
        Rename-Item -Path $_.FullName -NewName $newName -Force
        Write-Host "Renamed: $oldName -> $newName" -ForegroundColor Yellow
    }
}

Write-Host "`nFile Renaming Complete." -ForegroundColor Cyan
