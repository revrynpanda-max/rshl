# KAI RSHL Terminal Monitor v1.2
$pulseFile = "C:\KAI\data\kai_pulse.json"
$heartbeatFile = "C:\KAI\data\heartbeat.json"

function Get-ProgressBar($pct, $width) {
    $done = [math]::Round($width * ($pct / 100))
    if ($done -lt 0) { $done = 0 }
    if ($done -gt $width) { $done = $width }
    $todo = $width - $done
    $bar = "[" + ("#" * $done) + ("-" * $todo) + "]"
    return $bar
}

while ($true) {
    if (Test-Path $pulseFile) {
        try {
            $content = Get-Content $pulseFile -Raw
            $pulse = $content | ConvertFrom-Json
            
            $hbContent = Get-Content $heartbeatFile -Raw
            $hb = $hbContent | ConvertFrom-Json
            
            Clear-Host
            Write-Host "  KAI - RSHL ENGINE LIVE TELEMETRY" -ForegroundColor Cyan
            Write-Host "  --------------------------------------------------------" -ForegroundColor Gray
            Write-Host "  RUN: $($pulse.run) / 6 | DOMAIN: $($pulse.domain)" -ForegroundColor Yellow
            Write-Host "  PHASE: $($pulse.phase) | TS: $(Get-Date -Format 'HH:mm:ss')" -ForegroundColor Gray
            Write-Host ""
            
            $pct = 0
            if ($pulse.cycles_total -gt 0) {
                $pct = [math]::Round(($pulse.cycles_done / $pulse.cycles_total) * 100)
            }
            if ($pct -gt 100) { $pct = 100 }
            
            $barStr = Get-ProgressBar $pct 40
            Write-Host "  SEARCH CYCLES: $barStr $pct%" -ForegroundColor Cyan
            Write-Host "  $($pulse.cycles_done) / $($pulse.cycles_total) cycles complete" -ForegroundColor Gray
            Write-Host ""
            
            Write-Host "  METRICS:" -ForegroundColor White
            Write-Host "  * BRIDGES: $($pulse.bridges)" -ForegroundColor Green
            Write-Host "  * CHI-REJECT: $($pulse.chi)" -ForegroundColor Red
            Write-Host "  * PHI-DROP: $($pulse.phi_drop)" -ForegroundColor Magenta
            Write-Host "  * CPU LOAD: $($hb.cpu_load)%" -ForegroundColor Cyan
            
            Write-Host ""
            Write-Host "  [CTRL+C to Exit Monitor]" -ForegroundColor Gray
        } catch {
            # Skip frame on error
        }
    } else {
        Clear-Host
        Write-Host "Waiting for lattice pulse file..."
    }
    Start-Sleep -Seconds 2
}
