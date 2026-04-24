$m = Get-Content C:\KAI\kai-rust\data\cells-manifest.json -Raw | ConvertFrom-Json
Write-Host ("total cells: " + $m.cells.Count)
Write-Host "first 3 cells:"
$m.cells | Select-Object -First 3 | ForEach-Object {
    Write-Host ("  text=[" + $_.text + "] source=[" + $_.source + "] region=[" + $_.region + "]")
}
Write-Host ""
Write-Host "source histogram:"
$m.cells | ForEach-Object { $_.source } | Group-Object | Sort-Object Count -Descending | Select-Object -First 12 | Format-Table Count, Name -AutoSize
