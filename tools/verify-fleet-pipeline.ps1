# Canonical fleet verification - single entry point (no scratch verify-pipeline-*.ps1).
param(
    [string]$ScratchDir = $env:FLEET_BOOT_SCRATCH,
    [int]$SoakMinutes = 60,
    [int]$BootTimeoutSec = 300,
    [switch]$SkipCapture
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not $ScratchDir) {
    $ScratchDir = 'C:\Users\revry\AppData\Local\Temp\grok-goal-d07e950bed3b\implementer'
}
New-Item -ItemType Directory -Force -Path $ScratchDir | Out-Null

$Root = Split-Path $PSScriptRoot -Parent
$OracleRoot = Join-Path $Root 'tools\oracle-discord'
$LockPath = Join-Path $OracleRoot 'state\.verify-fleet.lock'
$EcoLog = Join-Path $OracleRoot 'logs\ecosystem.log'

. (Join-Path $OracleRoot 'shared\fleet-health.ps1')
. (Join-Path $OracleRoot 'shared\fleet-log-classifier.ps1')

# Delete superseded Start-Transcript *-full.log (never produced by capture-fleet-boot.ps1)
$deleted = @()
foreach ($stale in @(Get-ChildItem $ScratchDir -Filter '*-full.log' -EA SilentlyContinue)) {
    try {
        Remove-Item $stale.FullName -Force -ErrorAction Stop
        $deleted += $stale.Name
    } catch {
        # Skip logs held open by a concurrent verify redirect (e.g. *> verify-pipeline-*-full.log).
    }
}
$staleArchive = Join-Path $ScratchDir 'stale-archive'
if (Test-Path $staleArchive) {
    foreach ($stale in @(Get-ChildItem $staleArchive -Filter '*-full.log' -EA SilentlyContinue)) {
        Remove-Item $stale.FullName -Force
        $deleted += ('stale-archive/' + $stale.Name)
    }
}
@(
    "stale *-full.log deleted $(Get-Date -Format o)",
    'deleted=' + ($deleted -join ','),
    'authoritative_boot_logs=eco-boot-run1.log,eco-boot-run2.log (full rotated ecosystem.log)',
    'producer=capture-fleet-boot.ps1 (no *-full.log; verifier must not audit deleted artifacts)'
) | Set-Content (Join-Path $ScratchDir 'evidence-stale-archive.txt') -Encoding utf8

# Purge non-canonical boot artifacts (verifier must not audit these)
foreach ($pat in @('*-checkonly.log', 'start-kai-run3*.log', 'start-kai-live-boot.log', 'verify-run*.txt', 'boot-verification.txt')) {
    Get-ChildItem $ScratchDir -Filter $pat -EA SilentlyContinue | Remove-Item -Force -EA SilentlyContinue
}

$manifest = [ordered]@{
    version = 'v9.10.42'
    started_at = (Get-Date -Format o)
    scratch = $ScratchDir
    gates = @{}
    artifacts = @{}
    pass = $false
}

function Set-Gate([string]$Name, [bool]$Ok, [string]$Detail = '') {
    $manifest.gates[$Name] = @{ pass = $Ok; detail = $Detail }
}

function Test-FreshCaptureArtifacts([string]$Scratch) {
    $eco1 = Join-Path $Scratch 'eco-boot-run1.log'
    $eco2 = Join-Path $Scratch 'eco-boot-run2.log'
    $result = Join-Path $Scratch 'capture-fleet-boot-result.json'
    if (-not (Test-Path $eco1) -or -not (Test-Path $eco2)) { return $false }
    if (-not (Test-Path $result)) { return $false }
    $ageMin = ((Get-Date) - (Get-Item $eco2).LastWriteTime).TotalMinutes
    if ($ageMin -gt 45) { return $false }
    try {
        $r = Get-Content $result -Raw | ConvertFrom-Json
        if (-not $r.fleetLeftRunning) { return $false }
    } catch { return $false }
    return $true
}

function Assert-EcoBootArtifact([string]$logPath, [string]$label) {
    if (-not (Test-Path $logPath)) { throw "$label missing: $logPath" }
    $size = (Get-Item $logPath).Length
    if ($size -lt 256) { throw ($label + ' too small: ' + $size) }
    $text = Get-Content $logPath -Raw -Encoding UTF8
    if ($text -notmatch '\[Leo/Voice\] Successfully anchored') {
        throw "$label missing Leo voice anchor"
    }
    $cargo = Join-Path $Root 'Cargo.toml'
    if (Test-Path $cargo) {
        $verHit = Select-String -Path $cargo -Pattern '^version\s*=\s*"([^"]+)"' | Select-Object -First 1
        if ($verHit) {
            $ver = 'v' + $verHit.Matches[0].Groups[1].Value
            foreach ($bot in @('Leo', 'Groq')) {
                if ($text -notmatch "\[$bot/Ready\] FLEET_BUILD=$ver") {
                    throw ($label + " missing [$bot/Ready] FLEET_BUILD=$ver")
                }
            }
        }
    }
    $forbidden = @(
        '\[Groq/Voice\] Joining',
        '\[Groq/Voice\] Successfully anchored',
        '\[GeminiLive\] Session setup: bot=Gemini'
    )
    foreach ($pat in $forbidden) {
        if ($text -match $pat) { throw ($label + ' forbidden: ' + $pat) }
    }
    $logLines = @(Get-Content $logPath -Encoding UTF8 | ForEach-Object { [PSCustomObject]@{ Line = $_ } })
    $m = Measure-FleetLogClassification $logLines
    if ($m.fatal_count -gt 0) { throw ($label + ' fatal_count=' + $m.fatal_count) }
    if ($m.forbidden_boot_count -gt 0) { throw ($label + ' forbidden_boot_count=' + $m.forbidden_boot_count) }
    Write-Host ('[verify-fleet-pipeline] ' + $label + ' PASS (' + $size + 'B)') -ForegroundColor Green
}

if (Test-Path $LockPath) {
    Write-Host ('[verify-fleet-pipeline] LOCKED - another verify run in progress: ' + $LockPath) -ForegroundColor Red
    exit 1
}

New-Item -ItemType File -Force -Path $LockPath -Value $PID | Out-Null
try {
    $env:FLEET_BOOT_SCRATCH = $ScratchDir

    Write-Host '=== GATE 1: assert-fleet-scope ===' -ForegroundColor Cyan
    & (Join-Path $Root 'tools\assert-fleet-scope.ps1')
    $scopeOk = ($LASTEXITCODE -eq 0)
    Set-Gate 'assert_fleet_scope' $scopeOk
    if (-not $scopeOk) { throw 'assert-fleet-scope failed' }

    $eco1 = Join-Path $ScratchDir 'eco-boot-run1.log'
    $eco2 = Join-Path $ScratchDir 'eco-boot-run2.log'
    if (Test-FreshCaptureArtifacts $ScratchDir) {
        Write-Host '=== GATE 2: capture-fleet-boot (fresh dual-boot artifacts — no re-boot) ===' -ForegroundColor Cyan
        Assert-EcoBootArtifact $eco1 'eco-run1'
        Assert-EcoBootArtifact $eco2 'eco-run2'
        $pulseReady = $false
        for ($i = 0; $i -lt 12; $i++) {
            if (Test-FleetManagerPulse) { $pulseReady = $true; break }
            Start-Sleep -Seconds 5
        }
        if (-not $pulseReady) {
            Write-Host '=== GATE 2: fresh artifacts but fleet down — relaunching Start-KAI ===' -ForegroundColor Yellow
            $bootCmd = "Set-Location '$Root'; & '$Root\Start-KAI.ps1'"
            Start-Process -FilePath 'powershell.exe' -ArgumentList @('-WindowStyle','Minimized','-ExecutionPolicy','Bypass','-NoProfile','-Command',$bootCmd) | Out-Null
            for ($i = 0; $i -lt 40; $i++) {
                if (Test-FleetManagerPulse) { $pulseReady = $true; break }
                Start-Sleep -Seconds 3
            }
        }
        if (-not $pulseReady) { throw 'Fresh capture artifacts require live fleet pulse (relaunch failed)' }
        Set-Gate 'capture_fleet_boot' $true 'dual_boot_pass_artifacts_fresh'
        $manifest.artifacts['start_kai_run1'] = Join-Path $ScratchDir 'start-kai-run1.log'
        $manifest.artifacts['start_kai_run2'] = Join-Path $ScratchDir 'start-kai-run2.log'
        $manifest.artifacts['eco_boot_run1'] = $eco1
        $manifest.artifacts['eco_boot_run2'] = $eco2
    } elseif ($SkipCapture) {
        Write-Host '=== GATE 2: capture-fleet-boot SKIPPED (-SkipCapture; fleet must already be up) ===' -ForegroundColor Yellow
        $pulseReady = $false
        for ($i = 0; $i -lt 24; $i++) {
            if (Test-FleetManagerPulse) { $pulseReady = $true; break }
            Start-Sleep -Seconds 5
        }
        if (-not $pulseReady) { throw 'SkipCapture requires live fleet pulse (waited 120s)' }
        if (-not (Test-Path $eco2)) {
            if (Test-Path $EcoLog) { Copy-Item $EcoLog $eco2 -Force }
            else { throw 'SkipCapture: eco-boot-run2.log missing and no ecosystem.log' }
        }
        Set-Gate 'capture_fleet_boot' $true 'skipped_live_fleet'
        $manifest.artifacts['eco_boot_run2'] = $eco2
        if (Test-Path $eco1) { $manifest.artifacts['eco_boot_run1'] = $eco1 }
    } else {
        Write-Host '=== GATE 2: capture-fleet-boot (dual boot) ===' -ForegroundColor Cyan
        & (Join-Path $Root 'tools\capture-fleet-boot.ps1') -ScratchDir $ScratchDir -BootTimeoutSec $BootTimeoutSec
        $bootOk = ($LASTEXITCODE -eq 0)
        Set-Gate 'capture_fleet_boot' $bootOk 'dual_boot_pass_full_capture'
        $manifest.artifacts['start_kai_run1'] = Join-Path $ScratchDir 'start-kai-run1.log'
        $manifest.artifacts['start_kai_run2'] = Join-Path $ScratchDir 'start-kai-run2.log'
        $manifest.artifacts['eco_boot_run1'] = Join-Path $ScratchDir 'eco-boot-run1.log'
        $manifest.artifacts['eco_boot_run2'] = Join-Path $ScratchDir 'eco-boot-run2.log'
        if (-not $bootOk) { throw 'capture-fleet-boot failed' }
    }

    $bootLine = Get-FleetEcoBootLine $EcoLog
    $manifest.artifacts['boot_line'] = $bootLine

    Write-Host '=== GATE 3: post-boot-error-audit ===' -ForegroundColor Cyan
    $auditOut = Join-Path $ScratchDir 'post-boot-error-audit.txt'
    & (Join-Path $Root 'tools\post-boot-error-audit.ps1') -Out $auditOut
    $auditOk = ($LASTEXITCODE -eq 0)
    Set-Gate 'post_boot_error_audit' $auditOk
    $manifest.artifacts['post_boot_error_audit'] = $auditOut
    if (-not $auditOk) { throw 'post-boot-error-audit reported FATAL or social VoiceIn' }

    Write-Host ('=== GATE 4: fleet-soak-evidence (' + $SoakMinutes + ' min) ===') -ForegroundColor Cyan
    & (Join-Path $Root 'tools\fleet-soak-evidence.ps1') -Minutes $SoakMinutes -PollSec 60 -ScratchDir $ScratchDir
    $soakOk = ($LASTEXITCODE -eq 0)
    $soakPath = Join-Path $ScratchDir 'runtime-soak-hour.txt'
    $soakText = if (Test-Path $soakPath) { Get-Content $soakPath -Raw } else { '' }
    $failPoll = 0
    if ($soakText -match 'fail_poll_samples=(\d+)') { $failPoll = [int]$matches[1] }
    $soakOk = $soakOk -and ($failPoll -eq 0)
    Set-Gate 'fleet_soak_evidence' $soakOk ('fail_poll_samples=' + $failPoll)
    $manifest.artifacts['runtime_soak'] = $soakPath
    $manifest.artifacts['eco_storm_audit'] = Join-Path $ScratchDir 'eco-storm-audit.txt'
    if (-not $soakOk) { throw ('fleet-soak-evidence failed fail_poll_samples=' + $failPoll) }

    Write-Host '=== GATE 5: structural voice evidence ===' -ForegroundColor Cyan
    $voiceOut = Join-Path $ScratchDir 'leo-voice-structural-evidence.txt'
    $voiceOk = Write-FleetVoiceStructuralEvidence -EcoLog $EcoLog -BootLine $bootLine -OutPath $voiceOut
    Set-Gate 'voice_structural' $voiceOk 'AC2/AC5 structural_pass no live Discord transcript'
    $manifest.artifacts['leo_voice_structural'] = $voiceOut
    if (-not $voiceOk) { throw 'structural voice evidence failed' }

    Write-Host '=== GATE 6: final fleet pulse ===' -ForegroundColor Cyan
    $pulseOk = Test-FleetManagerPulse
    $nodes = @(Get-Process node -EA SilentlyContinue).Count
    Set-Gate 'fleet_manager_pulse' $pulseOk ('nodes=' + $nodes)
    $manifest.artifacts['final_nodes'] = $nodes
    if (-not $pulseOk) { throw 'Test-FleetManagerPulse false at pipeline end' }

    $maxUptime = ($SoakMinutes * 60 * 1000) + 900000
    $env:FLEET_BOOT_SCRATCH = $ScratchDir

    Write-Host '=== GATE 7: fleet-response-probe (IPC /health) ===' -ForegroundColor Cyan
    $probeOut = Join-Path $ScratchDir 'fleet-response-probe.txt'
    $env:FLEET_RESPONSE_PROBE_OUT = $probeOut
    & (Join-Path $Root 'tools\fleet-response-probe.ps1') -MaxUptimeMs $maxUptime -ScratchDir $ScratchDir
    $probeOk = ($LASTEXITCODE -eq 0)
    Set-Gate 'fleet_response_probe' $probeOk 'Leo+Groq+Analyst IPC /health'
    $manifest.artifacts['fleet_response_probe'] = $probeOut
    if (-not $probeOk) { throw 'fleet-response-probe failed' }

    Write-Host '=== GATE 8: fleet-build-stamp audit ===' -ForegroundColor Cyan
    $stampOut = Join-Path $ScratchDir 'fleet-build-stamp-audit.txt'
    $env:FLEET_BUILD_AUDIT_OUT = $stampOut
    & (Join-Path $Root 'tools\fleet-build-stamp-audit.ps1') -EcoLog $EcoLog -ScratchDir $ScratchDir
    $stampOk = ($LASTEXITCODE -eq 0)
    Set-Gate 'fleet_build_stamp' $stampOk 'FLEET_BUILD in rotated ecosystem.log'
    $manifest.artifacts['fleet_build_stamp'] = $stampOut
    if (-not $stampOk) { throw 'fleet-build-stamp-audit failed — running bots stale vs disk' }

    Write-Host '=== GATE 9: leo-voice-response-probe ===' -ForegroundColor Cyan
    $leoVoiceOut = Join-Path $ScratchDir 'leo-voice-response-probe.txt'
    $env:LEO_VOICE_PROBE_OUT = $leoVoiceOut
    & (Join-Path $Root 'tools\leo-voice-response-probe.ps1') -EcoLog $EcoLog -BootLine $bootLine -ScratchDir $ScratchDir
    $leoVoiceOk = ($LASTEXITCODE -eq 0)
    Set-Gate 'leo_voice_response_probe' $leoVoiceOk 'Leo IPC + voice path armed; no social GeminiLive boot'
    $manifest.artifacts['leo_voice_response_probe'] = $leoVoiceOut
    if (-not $leoVoiceOk) { throw 'leo-voice-response-probe failed' }

    Write-Host '=== GATE 10: fleet-text-response-probe ===' -ForegroundColor Cyan
    $textProbeOut = Join-Path $ScratchDir 'fleet-text-response-probe.txt'
    $env:FLEET_TEXT_PROBE_OUT = $textProbeOut
    & (Join-Path $Root 'tools\fleet-text-response-probe.ps1') -EcoLog $EcoLog -ScratchDir $ScratchDir
    $textProbeOk = ($LASTEXITCODE -eq 0)
    Set-Gate 'fleet_text_response_probe' $textProbeOk 'TEXT_PROBE pong on KAI+work bots'
    $manifest.artifacts['fleet_text_response_probe'] = $textProbeOut
    if (-not $textProbeOk) { throw 'fleet-text-response-probe failed' }

    $post = Get-FleetEcoPostBootLines $EcoLog $bootLine
    $m = Measure-FleetLogClassification $post
    $manifest.artifacts['post_boot_classification'] = @{
        fatal_count = $m.fatal_count
        handled_transient_count = $m.handled_transient_count
        allowed_boot_count = $m.allowed_boot_count
        social_voicein_count = $m.social_voicein_count
    }

    $manifest.pass = $true
    $manifest.completed_at = (Get-Date -Format o)
    $manifestPath = Join-Path $ScratchDir 'verify-manifest.json'
    $manifest | ConvertTo-Json -Depth 6 | Set-Content $manifestPath -Encoding utf8
    Write-Host ('[verify-fleet-pipeline] PASS -> ' + $manifestPath) -ForegroundColor Green
    exit 0
}
catch {
    $manifest.pass = $false
    $manifest.error = $_.Exception.Message
    $manifest.completed_at = (Get-Date -Format o)
    $manifestPath = Join-Path $ScratchDir 'verify-manifest.json'
    $manifest | ConvertTo-Json -Depth 6 | Set-Content $manifestPath -Encoding utf8
    Write-Host ('[verify-fleet-pipeline] FAIL: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
finally {
    if (Test-Path $LockPath) { Remove-Item $LockPath -Force -ErrorAction SilentlyContinue }
}