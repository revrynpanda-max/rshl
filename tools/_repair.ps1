$path = 'C:\KAI\kai-rust\src\main.rs'
$raw = [System.IO.File]::ReadAllText($path)
$orig_len = $raw.Length

# Detect EOL convention in this file
if ($raw.Contains("`r`n")) { $eol = "`r`n" } else { $eol = "`n" }

# 1. Add CLI hookup for --reset-continuations. Insert after the --force-warm block.
$needle_cli = @"
    if args.iter().any(|a| a == "--force-warm-all-responses") {
        force_warm_all_responses();
        return Ok(());
    }
"@ -replace "`r`n", $eol -replace "`n", $eol

if (-not $raw.Contains($needle_cli)) { Write-Host "cli anchor (force-warm) not found"; exit 1 }

$new_cli = $needle_cli + $eol + (@'

    // ── `kai --reset-continuations` — wipe the force-warm poisoning ─────
    // Zeros out every cell's `continuation` and `last_fired`. Use this
    // to undo a bad warm-up run before re-warming from scratch.
    if args.iter().any(|a| a == "--reset-continuations") {
        reset_continuations();
        return Ok(());
    }
'@ -replace "`r`n", $eol -replace "`n", $eol)

$raw = $raw.Replace($needle_cli, $new_cli)
Write-Host "reset-continuations CLI hookup inserted"

# 2. Add reset_continuations() function body just before seed_universe.
$fn_anchor = "fn seed_universe(u: &mut Universe) {"
$fn_pos = $raw.IndexOf($fn_anchor)
if ($fn_pos -lt 0) { Write-Host "seed_universe anchor not found"; exit 2 }

$reset_fn = @'
/// Zero out `continuation` and `last_fired` on every cell. Call this to
/// undo a bad warm-up run (e.g. `--force-warm-all-responses` that
/// equalized all continuations into identical bundles). After reset,
/// the state is ready for a fresh targeted re-warm.
fn reset_continuations() {
    let base_dir = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| ".".to_string());
    let (mut universe, candidates, drive, tick, dream_count) =
        match kai::persistence::load(&base_dir) {
            Some(tup) => tup,
            None => {
                eprintln!("ERROR: no saved state at {}/data/kai-state.json", base_dir);
                std::process::exit(1);
            }
        };

    let before = universe
        .cells()
        .iter()
        .filter(|c| c.continuation.nnz() > 0)
        .count();
    let total = universe.count();

    let mut zeroed = 0usize;
    for cell in universe.cells_mut().iter_mut() {
        if cell.continuation.nnz() > 0 || cell.last_fired != 0 {
            cell.continuation = SparseVec::zero();
            cell.last_fired = 0;
            zeroed += 1;
        }
    }

    println!("── KAI continuation reset ──");
    println!("cells total:                        {}", total);
    println!("had non-empty continuation (before): {}", before);
    println!("cells touched:                      {}", zeroed);
    println!("had non-empty continuation (after):  0");

    let save_res = kai::persistence::save(
        &universe,
        &candidates,
        &drive,
        tick,
        dream_count,
        &base_dir,
    );
    if save_res.ok {
        println!("saved: {} cells, {} bytes", save_res.cells, save_res.bytes);
    } else {
        eprintln!("ERROR: save failed");
        std::process::exit(2);
    }
}

'@ -replace "`r`n", $eol -replace "`n", $eol

$raw = $raw.Insert($fn_pos, $reset_fn)
Write-Host "reset_continuations fn inserted"

# 3. Extend diagnose_predictive() to accept --source=<tag>.
$old_diag = @'
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
'@ -replace "`r`n", $eol -replace "`n", $eol

$new_diag = @'
    // Optional --source=<tag> filter to diagnose a specific source path
    // (e.g. --source=greeting to see what the voice module's greeting
    // query is actually scoring).
    let source_filter: Option<String> = std::env::args()
        .find(|a| a.starts_with("--source="))
        .map(|a| a.trim_start_matches("--source=").to_string());

    if let Some(ref s) = source_filter {
        println!("source filter:             {:?}", s);
        let eligible_in_source = universe
            .cells()
            .iter()
            .filter(|c| &c.source == s)
            .count();
        println!("cells in source:           {}", eligible_in_source);
    }
    println!();

    let inputs = ["hey", "hey", "hey", "hey"];
    let mut trace = ConversationTrace::new();

    for (turn_idx, input_text) in inputs.iter().enumerate() {
        trace.push(input_text, "user");
        let input_vec = SparseVec::encode(input_text);
        let rows = match &source_filter {
            Some(s) => universe.diagnose_predictive_by_source(
                input_vec,
                s,
                &trace,
                kai::core::predictive::DEFAULT_ITER_STEPS,
                10,
            ),
            None => universe.diagnose_predictive(
                input_vec,
                &trace,
                kai::core::predictive::DEFAULT_ITER_STEPS,
                10,
            ),
        };
'@ -replace "`r`n", $eol -replace "`n", $eol

if (-not $raw.Contains($old_diag)) { Write-Host "diagnose body anchor not found"; exit 3 }
$raw = $raw.Replace($old_diag, $new_diag)
Write-Host "diagnose_predictive extended with source filter"

$tmp = "$path.newpatched"
[System.IO.File]::WriteAllText($tmp, $raw)

$attempts = 0
while ($attempts -lt 20) {
    try {
        $bak = "$path.pre_repair.bak"
        if (Test-Path $bak) { Remove-Item $bak -Force }
        Move-Item -Path $path -Destination $bak -Force -ErrorAction Stop
        Move-Item -Path $tmp -Destination $path -Force -ErrorAction Stop
        Write-Host "main.rs swap OK ($((Get-Item $path).Length) bytes, was $orig_len)"
        break
    } catch {
        $attempts++
        Start-Sleep -Milliseconds 500
        if ($attempts -ge 20) { Write-Host "main.rs swap failed: $_"; exit 4 }
    }
}
