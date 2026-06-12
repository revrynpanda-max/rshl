param(
    [int]$Tail = 60,
    [string]$Filter = "",          # e.g. -Filter "Oracle|Leo|ERROR|Kai Coder|pipeline"
    [switch]$Essentials,           # Essentials mode: focus on live agents + important signals, hide noise
    [switch]$IncludePipeline       # Also tail the overnight learning pipeline logs if present
)

$log = Join-Path $PSScriptRoot "logs\ecosystem.log"
if (-not (Test-Path $log)) {
    Write-Host "No ecosystem.log yet - has the fleet been started?" -ForegroundColor Yellow
    exit 1
}

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if ($Essentials) {
    # Good default for your "essentials + learning" workflow: Leo, Oracle, KAI core, errors, resource, proposals
    if (-not $Filter) {
        $Filter = "Oracle|Leo|KAI|ERROR|WARN|PROPOSE|Coder|sleep|wake|resource|pressure|headroom"
    }
    Write-Host "Watching ESSENTIALS (live fleet + key signals) from $log  |  Ctrl+C to stop" -ForegroundColor Cyan
} else {
    Write-Host "Watching $log (Ctrl+C to stop - bots keep running)" -ForegroundColor Cyan
}

if ($Filter) {
    Get-Content $log -Wait -Tail $Tail -Encoding UTF8 | Where-Object { $_ -match $Filter }
} else {
    Get-Content $log -Wait -Tail $Tail -Encoding UTF8
}

# Optional: also watch the learning pipeline in the same window (separate tail)
if ($IncludePipeline) {
    $pipeLog = "C:\KAI\overnight_pipeline.log"  # adjust if the pipeline writes its own log
    if (Test-Path $pipeLog) {
        Write-Host "`n--- Also tailing pipeline log (separate thread) ---" -ForegroundColor DarkGray
        Start-Job -ScriptBlock {
            param($pLog, $pTail)
            Get-Content $pLog -Wait -Tail $pTail -Encoding UTF8 | ForEach-Object { "[PIPELINE] $_" }
        } -ArgumentList $pipeLog, $Tail | Out-Null
        # Note: the job output will appear in this console too
    }
}
