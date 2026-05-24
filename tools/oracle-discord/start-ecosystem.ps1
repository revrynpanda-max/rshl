$env:NODE_NO_WARNINGS = "1"
Set-Location -LiteralPath "C:\KAI\tools\oracle-discord"
Start-Process -FilePath "node" -ArgumentList "ecosystem-manager.mjs" -WorkingDirectory "C:\KAI\tools\oracle-discord" -WindowStyle Hidden
Start-Sleep -Seconds 2
Write-Host "Ecosystem manager launched in background."
