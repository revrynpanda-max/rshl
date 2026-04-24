$path = 'C:\KAI\kai-rust\src\core\universe.rs'
$raw = [System.IO.File]::ReadAllText($path)
$orig_len = $raw.Length

# Insert a diagnostic method right after `predictive_query_by_source` -> just before `fn predictive_query_filtered`.
$anchor = "    fn predictive_query_filtered<F>("
$pos = $raw.IndexOf($anchor)
if ($pos -lt 0) { Write-Host "anchor not found"; exit 1 }

# Line ending near here is CRLF (we confirmed earlier). Use CRLF.
$eol = "`r`n"

$diag_struct = @'
/// Per-cell breakdown of the predictive-query score. Used by the
/// `--diagnose-predictive` CLI to show exactly why the lattice picked
/// the cells it picked.
#[derive(Debug, Clone)]
pub struct PredictiveScoreBreakdown {
    pub text: String,
    pub source: String,
    pub sim: f32,
    pub predict_match: f32,
    pub mh: f32,
    pub rec: f32,
    pub score: f32,
    pub last_fired: u64,
    pub continuation_nnz: usize,
}

'@ -replace "`r`n", $eol -replace "`n", $eol

# Put the breakdown struct just before `impl Universe {` — find the first occurrence.
$impl_anchor = "impl Universe {"
$impl_pos = $raw.IndexOf($impl_anchor)
if ($impl_pos -lt 0) { Write-Host "impl Universe not found"; exit 2 }
$raw = $raw.Insert($impl_pos, $diag_struct)
Write-Host "struct inserted at $impl_pos"

# Re-find anchor after insertion.
$pos = $raw.IndexOf($anchor)

$diag_method = @'
    /// Diagnostic variant of `predictive_query` that returns the full
    /// per-component score breakdown for the top-k cells. Same pipeline
    /// as `predictive_query_filtered`, but exposes `sim`,
    /// `predict_match`, `mh`, `rec` and the final score so the CLI can
    /// print why the lattice picked what it picked.
    pub fn diagnose_predictive(
        &self,
        input: SparseVec,
        trace: &ConversationTrace,
        steps: usize,
        top_k: usize,
    ) -> Vec<PredictiveScoreBreakdown> {
        let eligible: Vec<usize> = self
            .cells
            .iter()
            .enumerate()
            .filter(|(_, c)| c.source != "user-echo" && c.source != "conversation")
            .map(|(i, _)| i)
            .collect();
        if eligible.is_empty() {
            return Vec::new();
        }

        let iter_steps = steps.max(predictive::DEFAULT_ITER_STEPS);
        let mut state = input.clone();
        let dim = state.data.len();
        for _ in 0..iter_steps {
            let mut data = vec![0i8; dim];
            for i in 0..dim {
                let s = state.data[i] as i32;
                let t = trace.current.data[i] as i32;
                let conjunction = s * t;
                let v = 5 * s + 3 * t + 4 * conjunction;
                data[i] = if v >= 3 {
                    1
                } else if v <= -3 {
                    -1
                } else {
                    0
                };
            }
            state = SparseVec::from_raw(data);
        }

        let tick = trace.turns_seen;
        let prediction_anchor = trace.current.permute(1).contrast(&input);

        let mut rows: Vec<PredictiveScoreBreakdown> = eligible
            .par_iter()
            .map(|&i| {
                let cell = &self.cells[i];
                let sim = state.cosine(&cell.vec).max(0.0);
                let predict_match = prediction_anchor.cosine(&cell.continuation).max(0.0);
                let mh = predictive::multi_head_consensus(
                    &state,
                    &cell.vec,
                    predictive::DEFAULT_HEADS,
                );
                let rec = predictive::recency_penalty(
                    tick,
                    cell.last_fired,
                    predictive::RECENCY_WINDOW,
                );
                let score = 0.10 * sim + 0.65 * predict_match + 0.10 * mh - 0.45 * rec;
                PredictiveScoreBreakdown {
                    text: cell.text.clone(),
                    source: cell.source.clone(),
                    sim,
                    predict_match,
                    mh,
                    rec,
                    score,
                    last_fired: cell.last_fired,
                    continuation_nnz: cell.continuation.nnz(),
                }
            })
            .collect();
        rows.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        rows.truncate(top_k);
        rows
    }

'@ -replace "`r`n", $eol -replace "`n", $eol

$raw = $raw.Insert($pos, $diag_method)
Write-Host "diagnose_predictive inserted"

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
