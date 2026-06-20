param()

Write-Host "===============================================" -ForegroundColor Red
Write-Host "    KAI PHOENIX WATCHDOG: UNAUTHORIZED DEATH" -ForegroundColor Red
Write-Host "==============================================="
Write-Host ""
Write-Host "KAI went offline unexpectedly without an authorized stop marker."
Write-Host "This terminal was spawned to verify the cause."
Write-Host ""
$ans = Read-Host "Did you close KAI manually? (Y/N)"

if ($ans -match "^[yY]") {
    Write-Host "Understood. Creating authorized stop marker..." -ForegroundColor Green
    $stopMarker = @{ timestamp = (Get-Date).ToString("o"); authorized = $true }
    $stopMarker | ConvertTo-Json | Out-File -FilePath "C:\KAI\state\authorized_stop.json" -Encoding utf8
    Write-Host "Marker created. Watchdog will now stand down."
    Start-Sleep -Seconds 3
    exit 0
} else {
    Write-Host ""
    Write-Host "Crash detected. Executing cleanup..." -ForegroundColor Yellow
    
    $stopBat = "C:\KAI\KAI-Stop.bat"
    if (Test-Path $stopBat) {
        Start-Process -FilePath $stopBat -Wait -WindowStyle Hidden
    } else {
        # Fallback if Stop.bat is missing
        Stop-Process -Name kai -Force -ErrorAction SilentlyContinue
    }

    Write-Host "Cleanup complete."
    Write-Host ""
    $fleet = Read-Host "Do you want to start KAI back up? [1] Normal (Oracle/Leo) or [2] Full Fleet (-fullfleet) or [3] No"
    
    Set-Location "C:\KAI\tools\oracle-discord"
    if ($fleet -match "^1") {
        Write-Host "Starting Normal..."
        Start-Process "powershell" -ArgumentList "-ExecutionPolicy Bypass -File .\run-oracle-discord.ps1"
    } elseif ($fleet -match "^2") {
        Write-Host "Starting Full Fleet..."
        Start-Process "powershell" -ArgumentList "-ExecutionPolicy Bypass -File .\run-oracle-discord.ps1 -fullfleet"
    } else {
        Write-Host "Standing down."
    }
    Start-Sleep -Seconds 3
    exit 0
}
