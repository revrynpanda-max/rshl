# KAI Identity Recovery Script
$TargetDir = "C:\KAI\src-CLI code\src"

Write-Host "Consolidating GeometricIntelligence identity..." -ForegroundColor Cyan

Get-ChildItem -Path $TargetDir -Recurse -File | ForEach-Object {
    $file = $_.FullName
    $ext = [System.IO.Path]::GetExtension($file)
    
    if ($ext -match "tsx|ts|js|json") {
        $content = Get-Content $file -Raw
        $original = $content
        
        # Remove space from the identity to fix variable names
        $content = $content -replace "Geometric Intelligence", "GeometricIntelligence"
        
        if ($content -ne $original) {
            Set-Content -Path $file -Value $content -Encoding UTF8
            Write-Host "Fixed: $($_.Name)" -ForegroundColor Green
        }
    }
}

Write-Host "`nRecovery Complete." -ForegroundColor Cyan
