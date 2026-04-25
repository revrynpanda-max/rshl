param (
    [int]$MaxTempCelsius = 90,
    [int]$MinFreeRamMB = 1024
)

$logFile = "C:\KAI\data\phase_4_metrics.log"
$heartbeatFile = "C:\KAI\data\heartbeat.json"
$physicsFiles = @(
    "data\physics_quantum_vacuum.txt",
    "data\physics_string_theory.txt",
    "data\physics_spacetime_gr.txt",
    "data\physics_fibonacci_nature.txt"
)

function Write-Heartbeat($phase, $file, $status) {
    try {
        $os = Get-CimInstance Win32_OperatingSystem
        $proc = Get-CimInstance Win32_Processor | Select-Object -First 1
        $freeRam = [math]::Round($os.FreePhysicalMemory / 1024)
        $load = $proc.LoadPercentage
        
        $json = @{
            timestamp = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
            phase = $phase
            current_file = $file
            status = $status
            cpu_load = $load
            free_ram_mb = $freeRam
        } | ConvertTo-Json
        $json | Out-File -FilePath $heartbeatFile -Encoding utf8 -Force
    } catch {}
}

"--- RESUMING PHASE 4 (RUN 3: QUANTUM VACUUM) ---" | Out-File -FilePath $logFile -Append -Encoding utf8

foreach ($file in $physicsFiles) {
    Write-Heartbeat "INGESTION" $file "ACTIVE"
    "Starting ingestion of $file at $(Get-Date)" | Out-File -FilePath $logFile -Append -Encoding utf8
    
    & cargo run --release -- --train-hlv $file
    
    "Completed $file at $(Get-Date)" | Out-File -FilePath $logFile -Append -Encoding utf8
    Write-Heartbeat "COOLING" $file "RESTING"
    Start-Sleep -Seconds 300
}

Write-Heartbeat "FINISHED" "none" "DONE"
"--- PHASE 4 GOVERNOR FINISHED ---" | Out-File -FilePath $logFile -Append -Encoding utf8
