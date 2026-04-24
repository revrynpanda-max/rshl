$path = 'C:\KAI\kai-rust\src\cognition\voice.rs'
$raw = [System.IO.File]::ReadAllText($path)
$orig_len = $raw.Length

$old = @'
    if matches!(query_type, QueryType::Greeting) {
        let name = extract_introduced_name(&lower);

        // Predictive retrieval across greeting cells. The inquisitive vs
        // brief split is now a cheap post-filter: we fetch the top-5 hits
        // (already ranked by static + predictive + novelty - recency) and
        // prefer the register that matches the incoming opener's energy.
        let is_inquisitive = lower.contains("good")
            || lower.contains("up")
            || lower.contains("happening")
            || lower.contains("going");

        let hits_gr = universe.predictive_query_by_source(
            crate::core::SparseVec::encode(input),
            "greeting",
            trace,
            predictive::DEFAULT_ITER_STEPS,
        );

        let greeting_cell = if is_inquisitive {
'@
$old = $old -replace "`r`n", "`n"

# Normalize file to LF scan (content is LF in this section)
if (-not $raw.Contains($old)) { Write-Host 'greeting anchor not found'; exit 1 }

$new = @'
    if matches!(query_type, QueryType::Greeting) {
        let name = extract_introduced_name(&lower);

        // Stop hard-filtering to `source=greeting` on every input. Let
        // the full universe compete first — only fall back to the
        // greeting-only pool when no cell scores above the floor. This
        // kills the 4-cell rotation by letting seed / identity / world
        // cells win when they predict the next turn better.
        let is_inquisitive = lower.contains("good")
            || lower.contains("up")
            || lower.contains("happening")
            || lower.contains("going");

        const GREETING_FALLBACK_FLOOR: f32 = 0.25;

        let hits_all = universe.predictive_query(
            crate::core::SparseVec::encode(input),
            trace,
            predictive::DEFAULT_ITER_STEPS,
        );
        let hits_gr = if hits_all
            .first()
            .map(|h| h.score >= GREETING_FALLBACK_FLOOR)
            .unwrap_or(false)
        {
            hits_all
        } else {
            universe.predictive_query_by_source(
                crate::core::SparseVec::encode(input),
                "greeting",
                trace,
                predictive::DEFAULT_ITER_STEPS,
            )
        };

        let greeting_cell = if is_inquisitive {
'@
$new = $new -replace "`r`n", "`n"

$raw = $raw.Replace($old, $new)
Write-Host 'greeting block rewritten'

$tmp = "$path.newpatched"
[System.IO.File]::WriteAllText($tmp, $raw)

$attempts = 0
while ($attempts -lt 20) {
    try {
        $bak = "$path.pre_floor.bak"
        if (Test-Path $bak) { Remove-Item $bak -Force }
        Move-Item -Path $path -Destination $bak -Force -ErrorAction Stop
        Move-Item -Path $tmp -Destination $path -Force -ErrorAction Stop
        $newlen = (Get-Item $path).Length
        Write-Host ('swap OK ' + $newlen + ' bytes, was ' + $orig_len)
        break
    } catch {
        $attempts++
        Start-Sleep -Milliseconds 500
        if ($attempts -ge 20) { Write-Host 'swap failed'; exit 2 }
    }
}
