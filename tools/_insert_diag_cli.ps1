$path = 'C:\KAI\kai-rust\src\main.rs'
$raw = [System.IO.File]::ReadAllText($path)
$orig_len = $raw.Length

# 1. Insert the --diagnose-predictive hookup right after the force-warm block.
$needle_cli = "    if args.iter().any(|a| a == `"--force-warm-all-responses`") {`n        force_warm_all_responses();`n        return Ok(());`n    }"
if (-not $raw.Contains($needle_cli)) {
    # Try CRLF
    $needle_cli = "    if args.iter().any(|a| a == `"--force-warm-all-responses`") {`r`n        force_warm_all_responses();`r`n        return Ok(());`r`n    }"
    if (-not $raw.Contains($needle_cli)) { Write-Host "cli anchor not found"; exit 1 }
    $eol = "`r`n"
} else {
    $eol = "`n"
}

$hookup = $needle_cli + $eol + $eol + "    // `$`$`$ --diagnose-predictive `$`$`$`n".Replace('$$$', '──').Replace("`n", $eol)
# Actually, let me just build the hookup cleanly as a here-string and fix line endings.
$hookup = @'

    // ── `kai --diagnose-predictive [turns]` — dry-run the retrieval path
    // Simulates repeated "hey" turns against the current lattice and
    // prints the top-5 cells with their score breakdown: sim,
    // predict_match, mh, rec, and total. Lets us see *why* the lattice
    // picks what it picks without having to open the TUI.
    if args.iter().any(|a| a == "--diagnose-predictive") {
        diagnose_predictive();
        return Ok(());
    }
'@ -replace "`r`n", $eol -replace "`n", $eol

$raw = $raw.Replace($needle_cli, $needle_cli + $hookup)
Write-Host "cli hookup inserted"

# 2. Add the diagnose_predictive() function body before `fn seed_universe(u: &mut Universe)`.
$fn_anchor = "fn seed_universe(u: &mut Universe) {"
$fn_pos = $raw.IndexOf($fn_anchor)
if ($fn_pos -lt 0) { Write-Host "fn anchor not found"; exit 2 }

$fn_body = @'
/// Dry-run the predictive retrieval path without starting the TUI.
/// Simulates the user saying "hey" four times against the currently
/// saved state, and for each turn prints the top-5 cells with the
/// full score breakdown. Used to diagnose whether repetition is a
/// retrieval problem or a composer problem.
fn diagnose_predictive() {
    let base_dir = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| ".".to_string());
    let (universe, _candidates, _drive, _tick, _dream) =
        match kai::persistence::load(&base_dir) {
            Some(tup) => tup,
            None => {
                eprintln!("ERROR: no saved state at {}/data/kai-state.json", base_dir);
                std::process::exit(1);
            }
        };

    let total = universe.count();
    let eligible = universe
        .cells()
        .iter()
        .filter(|c| c.source != "user-echo" && c.source != "conversation")
        .count();
    let with_cont = universe
        .cells()
        .iter()
        .filter(|c| c.continuation.nnz() > 0)
        .count();
    println!("── KAI predictive retrieval diagnostic ──");
    println!("cells total:               {}", total);
    println!("response-eligible cells:   {}", eligible);
    println!("cells with continuations:  {}", with_cont);
    println!();

    let inputs = ["hey", "hey", "hey", "hey"];
    let mut trace = ConversationTrace::new();

    for (turn_idx, input_text) in inputs.iter().enumerate() {
        trace.push(input_text, "user");
        let input_vec = SparseVec::encode(input_text);
        let rows = universe.diagnose_predictive(
            input_vec,
            &trace,
            kai::core::predictive::DEFAULT_ITER_STEPS,
            10,
        );

        println!(
            "── turn {} · user: {:?} · trace.turns_seen={} · trace.current.nnz={} ──",
            turn_idx + 1,
            input_text,
            trace.turns_seen,
            trace.current.nnz()
        );
        println!(
            "  {:<4} {:<42} {:<13} {:>6} {:>6} {:>6} {:>6} {:>6} {:>6} {:>9}",
            "#", "text (truncated)", "source", "sim", "pred", "mh", "rec", "score", "cont", "lastFired"
        );
        for (rank, r) in rows.iter().enumerate() {
            let mut txt = r.text.clone();
            if txt.chars().count() > 40 {
                txt = txt.chars().take(37).collect::<String>() + "...";
            }
            println!(
                "  {:<4} {:<42} {:<13} {:>6.3} {:>6.3} {:>6.3} {:>6.3} {:>6.3} {:>6} {:>9}",
                rank + 1,
                txt,
                r.source,
                r.sim,
                r.predict_match,
                r.mh,
                r.rec,
                r.score,
                r.continuation_nnz,
                r.last_fired
            );
        }

        // Feed the top-1 into the trace as KAI's reply so subsequent
        // turns see a non-empty "kai last message" signature, just like
        // the live TUI does.
        if let Some(top) = rows.first() {
            trace.push(&top.text, "kai");
        }
        println!();
    }
}

'@ -replace "`r`n", $eol -replace "`n", $eol

$raw = $raw.Insert($fn_pos, $fn_body)
Write-Host "fn body inserted"

$tmp = "$path.newpatched"
[System.IO.File]::WriteAllText($tmp, $raw)

$attempts = 0
while ($attempts -lt 20) {
    try {
        $bak = "$path.pre_diag.bak"
        if (Test-Path $bak) { Remove-Item $bak -Force }
        Move-Item -Path $path -Destination $bak -Force -ErrorAction Stop
        Move-Item -Path $tmp -Destination $path -Force -ErrorAction Stop
        Write-Host "swap OK ($((Get-Item $path).Length) bytes, was $orig_len)"
        break
    } catch {
        $attempts++
        Start-Sleep -Milliseconds 500
        if ($attempts -ge 20) { Write-Host "swap failed: $_"; exit 3 }
    }
}
