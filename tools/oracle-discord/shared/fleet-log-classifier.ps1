# Shared fleet log classifier — one source of truth for audit, boot assert, manifest.
param()

function Get-FleetLogClassifierPatterns {
    [PSCustomObject]@{
        Fatal = 'exited with code|uncaughtException|null \(reading ''receiver''\)|Unhandled ''error'' event|EADDRINUSE|\[Groq\].*Failing over to gemini|\[OpenJarvis\] Groq:.*gemini|\[Groq\].*VoiceManager|\[Groq/Voice\] (Joining|Successfully anchored)|\[(Gemini|Claudey|X)/Voice\] (Joining|Successfully anchored)'
        AllowedBoot = 'Ollama already serving|Supervisor already running|OpenJarvis Already running|Overnight pipeline keeper already running|Infiray IR bridge already running'
        ForbiddenBoot = 'Engine already serving|\[2/4\] Engine already serving'
        HandledTransient = 'GoAway|Session restored|Rebuilding session|Connection closed: 1000|Stable on fallback|handled.:true|Mic listener skipped|Gemini Live OFF|TTS-output anchor \(no mic\)|Failing over to ollama|groq provider in cooldown|STREAK.*COOLDOWN|groq unavailable|Gateway Error: 503|NEURAL_RECOVERY|NEURAL_FAILURE.*handled|skipped essentials-sleep|Morning wake.*skipped|\[Ecosystem\].*exited with code.*Re-spawning'
        EcosystemRespawn = '\[Ecosystem\].*exited with code'
        SocialVoiceIn = '\[(Groq|Gemini|Claudey|X)/VoiceIn\]'
        LeoVoiceAnchor = '\[Leo/Voice\] Successfully anchored'
        GroqMicSkipped = 'Mic listener skipped|Gemini Live OFF'
        GroqRadioAnchor = '\[Groq/RadioOut\] TTS-output anchored'
        GroqForbiddenVoice = '\[Groq/Voice\]|\[Groq\].*VoiceManager'
    }
}

function Test-FleetLogBucket([string]$Line, [string]$Bucket) {
    if (-not $Line) { return $false }
    $p = Get-FleetLogClassifierPatterns
    switch ($Bucket) {
        'Fatal'           { return $Line -match $p.Fatal }
        'AllowedBoot'     { return $Line -match $p.AllowedBoot }
        'ForbiddenBoot'   { return $Line -match $p.ForbiddenBoot }
        'HandledTransient'{ return $Line -match $p.HandledTransient }
        'SocialVoiceIn'   { return $Line -match $p.SocialVoiceIn }
        'LeoVoiceAnchor'  { return $Line -match $p.LeoVoiceAnchor }
        'GroqMicSkipped'  { return $Line -match $p.GroqMicSkipped }
        'GroqRadioAnchor' { return $Line -match $p.GroqRadioAnchor }
        'GroqForbiddenVoice' { return $Line -match $p.GroqForbiddenVoice }
        'EcosystemRespawn'  { return $Line -match $p.EcosystemRespawn }
        default           { return $false }
    }
}

function Get-FleetEcoBootLine([string]$EcoLog) {
    $hit = Select-String -Path $EcoLog -Pattern '\[Ecosystem/BOOT\]' -EA SilentlyContinue | Select-Object -Last 1
    if ($hit) { return $hit.LineNumber }
    return 0
}

function Get-FleetEcoPostBootLines([string]$EcoLog, [int]$BootLine = 0) {
    if ($BootLine -le 0) { return @() }
    return @(Select-String -Path $EcoLog -Pattern '.' -EA SilentlyContinue | Where-Object { $_.LineNumber -gt $BootLine })
}

function Measure-FleetLogClassification([object[]]$Lines) {
    $fatal = @($Lines | Where-Object {
        (Test-FleetLogBucket $_.Line 'Fatal') -and
        -not (Test-FleetLogBucket $_.Line 'EcosystemRespawn')
    })
    $voiceIn = @($Lines | Where-Object { Test-FleetLogBucket $_.Line 'SocialVoiceIn' })
    $handled = @($Lines | Where-Object {
        -not (Test-FleetLogBucket $_.Line 'Fatal') -and
        -not (Test-FleetLogBucket $_.Line 'SocialVoiceIn') -and
        (Test-FleetLogBucket $_.Line 'HandledTransient')
    })
    $allowedBoot = @($Lines | Where-Object {
        -not (Test-FleetLogBucket $_.Line 'Fatal') -and
        (Test-FleetLogBucket $_.Line 'AllowedBoot')
    })
    $forbiddenBoot = @($Lines | Where-Object { Test-FleetLogBucket $_.Line 'ForbiddenBoot' })
    [PSCustomObject]@{
        fatal_count = $fatal.Count
        social_voicein_count = $voiceIn.Count
        handled_transient_count = $handled.Count
        allowed_boot_count = $allowedBoot.Count
        forbidden_boot_count = $forbiddenBoot.Count
        fatal = $fatal
        voiceIn = $voiceIn
        handled = $handled
        allowedBoot = $allowedBoot
        forbiddenBoot = $forbiddenBoot
    }
}

function Get-FleetHumanVoiceEvidence {
    param(
        [string]$EcoLog,
        [int]$BootLine = 0
    )
    if ($BootLine -le 0) { $BootLine = Get-FleetEcoBootLine $EcoLog }
    $post = Get-FleetEcoPostBootLines $EcoLog $BootLine
    $human = @()
    foreach ($hit in $post) {
        $line = $hit.Line
        if ($line -match 'speaker=Probe|path=probe|probe-inject|VoicePath/Probe|Leo voice path probe') { continue }
        if ($line -match 'GATE OPEN.*(Ryan|nastermodx)') { $human += $hit; continue }
        if ($line -match '\[Leo/HumanVoice\] path=(gemini-live|fallback)') { $human += $hit; continue }
        if ($line -match '\[Leo/MicLevel\].*OPENED.*frames sent to Gemini') { $human += $hit; continue }
        if ($line -match 'GATE CLEAR — transcript ready') { $human += $hit; continue }
    }
    [PSCustomObject]@{
        boot_line = $BootLine
        human_line_count = $human.Count
        gate_open = @($human | Where-Object { $_.Line -match 'GATE OPEN' })
        human_voice = @($human | Where-Object { $_.Line -match 'HumanVoice' })
        mic_level = @($human | Where-Object { $_.Line -match 'MicLevel' })
        gate_clear = @($human | Where-Object { $_.Line -match 'GATE CLEAR — transcript ready' })
        lines = $human
    }
}

function Write-FleetVoiceStructuralEvidence {
    param(
        [string]$EcoLog,
        [int]$BootLine,
        [string]$OutPath
    )
    $post = Get-FleetEcoPostBootLines $EcoLog $BootLine
    $leoAnchor = @($post | Where-Object { Test-FleetLogBucket $_.Line 'LeoVoiceAnchor' })
    $groqSkip = @($post | Where-Object { $_.Line -match '\[Groq\]' -and (Test-FleetLogBucket $_.Line 'GroqMicSkipped') })
    $voiceIn = @($post | Where-Object { Test-FleetLogBucket $_.Line 'SocialVoiceIn' })
    $m = Measure-FleetLogClassification $post

    $groqGeminiFail = @($post | Where-Object { $_.Line -match '\[Groq\].*Failing over to gemini|\[OpenJarvis\] Groq:.*gemini' })
    $groqTtsAnchor = @($post | Where-Object {
        $_.Line -match '\[Groq\].*TTS-output anchor \(no mic\)' -or (Test-FleetLogBucket $_.Line 'GroqRadioAnchor')
    })
    $groqForbidden = @($post | Where-Object { Test-FleetLogBucket $_.Line 'GroqForbiddenVoice' })
    $structuralPass = ($leoAnchor.Count -gt 0 -and $voiceIn.Count -eq 0 -and $groqGeminiFail.Count -eq 0 -and $groqForbidden.Count -eq 0)
    $lines = @(
        "=== LEO VOICE STRUCTURAL EVIDENCE $(Get-Date -Format o) ===",
        "boot_line=$BootLine",
        "structural_pass=$structuralPass",
        "leo_voice_anchored=$($leoAnchor.Count -gt 0)",
        "groq_mic_skipped_lines=$($groqSkip.Count)",
        "groq_forbidden_voice_lines=$($groqForbidden.Count)",
        "social_voicein_count=$($voiceIn.Count)",
        "handled_transient_count=$($m.handled_transient_count)",
        "fatal_count=$($m.fatal_count)",
        "",
        'TIER_1=structural_only: VOICE_PATH_PROBE probe-inject synthetic; NOT real human mic',
        'TIER_2=historical_real_human: pre-boot GATE OPEN Ryan + MicLevel frames to Gemini',
        'TIER_3=current_boot_owner_live: owner-voice-ear-check.ps1 -WaitSec 90 after UNMUTE',
        "TIER_4=stutter_feel: owner ear only",
        "fallback_path=runListenerCapturePipeline path=fallback only when Gemini Live unavailable; all probe evidence is probe-inject not fallback-for-human",
        "",
        "=== LEO ANCHOR (last 3) ==="
    ) + @($leoAnchor | Select-Object -Last 3 | ForEach-Object { "L$($_.LineNumber): $($_.Line.Trim())" })

    $lines += ""
    $lines += "groq_gemini_failover_count=$($groqGeminiFail.Count)"
    $lines += "groq_tts_anchor_count=$($groqTtsAnchor.Count)"
    $lines += ""
    $lines += "=== GROQ NO-EARS (last 3) ==="
    $lines += @($groqSkip | Select-Object -Last 3 | ForEach-Object { "L$($_.LineNumber): $($_.Line.Trim())" })
    $lines += ""
    $lines += "=== GROQ TTS ANCHOR (last 2, radio output only) ==="
    $lines += @($groqTtsAnchor | Select-Object -Last 2 | ForEach-Object { "L$($_.LineNumber): $($_.Line.Trim())" })

    $dir = Split-Path $OutPath -Parent
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $lines | Out-File $OutPath -Encoding utf8
    return $structuralPass
}