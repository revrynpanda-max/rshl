# KAI Identity Refactoring Script (Fixed)
$TargetDir = "C:\KAI\src-CLI code\src"

$Mappings = @(
    @("api.Geometric Intelligence.com", "127.0.0.1:3333"),
    @("api-staging.Geometric Intelligence.com", "127.0.0.1:3333"),
    @("Geometric Intelligence.com", "kai-engine.com"),
    @("KAI Code", "KAI Engine"),
    @("KAI", "KAI"),
    @("Geometric Intelligence", "Geometric Intelligence")
)

Write-Host "Starting Identity Refactor on $TargetDir..." -ForegroundColor Cyan

Get-ChildItem -Path $TargetDir -Recurse -File | ForEach-Object {
    $file = $_.FullName
    $ext = [System.IO.Path]::GetExtension($file)
    
    if ($ext -match "tsx|ts|js|json|md|txt") {
        $content = Get-Content $file -Raw
        $original = $content
        
        foreach ($m in $Mappings) {
            $old = $m[0]
            $new = $m[1]
            # Case-sensitive replace
            $content = [regex]::Replace($content, [regex]::Escape($old), $new, "IgnoreCase")
        }
        
        if ($content -ne $original) {
            Set-Content -Path $file -Value $content -Encoding UTF8
            Write-Host "Refactored: $($_.Name)" -ForegroundColor Green
        }
    }
}

Write-Host "`nRefactor Complete." -ForegroundColor Cyan
