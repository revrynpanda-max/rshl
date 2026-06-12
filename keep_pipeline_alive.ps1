# Keep the Kai learning pipeline (overnight_pipeline.py) alive in the background.
# Now fully hidden + lower priority so it doesn't pop consoles or fight the live essentials fleet (Leo/Oracle/KAI core).
# It already respects the self_optimize_state governor written by the live Oracle gateway.

$ErrorActionPreference = 'SilentlyContinue'

while ($true) {
    Write-Host "[PipelineKeeper] Starting overnight_pipeline.py (hidden, BelowNormal priority)..."

    # Launch python hidden, below normal priority, no new window.
    $proc = Start-Process -FilePath "python" `
        -ArgumentList "overnight_pipeline.py" `
        -WorkingDirectory "C:\KAI" `
        -WindowStyle Hidden `
        -PriorityLevel BelowNormal `
        -PassThru

    if ($proc) {
        Write-Host "[PipelineKeeper] Pipeline PID $($proc.Id) running at BelowNormal. Will restart on exit."
        $proc.WaitForExit()
        Write-Host "[PipelineKeeper] overnight_pipeline.py exited with code $($proc.ExitCode). Cooling down 8s before restart..."
    } else {
        Write-Host "[PipelineKeeper] Failed to start pipeline. Cooling down..."
    }

    Start-Sleep -Seconds 8
}
