# Keep the Kai learning pipeline (overnight_pipeline.py) alive in the background.
# Now fully hidden + lower priority so it doesn't pop consoles or fight the live essentials fleet (Leo/Oracle/KAI core).
# It already respects the self_optimize_state governor written by the live Oracle gateway.

$ErrorActionPreference = 'SilentlyContinue'

while ($true) {
    Write-Host "[PipelineKeeper] Starting overnight_pipeline.py (hidden, BelowNormal priority)..."

    # Launch python hidden, no new window. NOTE: Start-Process has NO -PriorityLevel
    # parameter — the old script passed it and (with SilentlyContinue) the launch FAILED
    # every loop, so overnight_pipeline.py never actually started. Set priority AFTER launch.
    # HIDDEN (no console window) — the owner asked for NO pop-up. Closing the old
    # Minimized window just made this keeper respawn it (loop below restarts on exit),
    # so the window kept coming back. Hidden runs it silently in the background; status
    # still posts to Discord (Startup Health Check / IDLING / training).
    # CAPTURE the live pipeline output to overnight_pipeline.log so the dashboard's
    # "Recent Stage Events" reflects the CURRENT run (was reading a stale old log because
    # stdout went nowhere). -u keeps Python unbuffered so the log is live. stdout/stderr
    # must be SEPARATE files for Start-Process; the dashboard tails the stdout one.
    $proc = Start-Process -FilePath "python" `
        -ArgumentList "-u","overnight_pipeline.py" `
        -WorkingDirectory "C:\KAI" `
        -WindowStyle Hidden `
        -RedirectStandardOutput "C:\KAI\overnight_pipeline.log" `
        -RedirectStandardError "C:\KAI\overnight_pipeline.err.log" `
        -PassThru

    if ($proc) {
        try { $proc.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::BelowNormal } catch {}
        Write-Host "[PipelineKeeper] Pipeline PID $($proc.Id) running at BelowNormal. Will restart on exit."
        $proc.WaitForExit()
        Write-Host "[PipelineKeeper] overnight_pipeline.py exited with code $($proc.ExitCode). Cooling down 8s before restart..."
    } else {
        Write-Host "[PipelineKeeper] Failed to start pipeline. Cooling down..."
    }

    Start-Sleep -Seconds 8
}
