/// Dream Lattice — Autonomous consolidation engine.
///
/// Ported from rshl-lattice.js. During dream cycles, KAI:
///   1. Picks two cells from the universe using replay priority scoring
///   2. Bundles their vectors to synthesize a new concept
///   3. Queries the universe for the best "cleanup" match
///   4. Computes full field state metrics (Φg, C, Wm, etc.)
///   5. Reinforces source cells based on Wm (memory reinforcement)
///   6. Tracks dream history for temporal recurrence (τ)
///
/// This is how KAI thinks while "asleep" — finding connections between
/// concepts he already has, and strengthening the ones that matter.

use crate::core::{SparseVec, Universe, FieldState};
use crate::core::field_state::{FieldInput, DreamHistoryEntry};
use rand::Rng;
use std::sync::Mutex;

/// Rolling dream history for temporal recurrence.
static DREAM_HISTORY: Mutex<Vec<DreamHistoryEntry>> = Mutex::new(Vec::new());
const MAX_DREAM_HISTORY: usize = 12;

/// Gate statistics — how many dreams were rejected vs accepted.
/// Useful for tuning thresholds and spotting when the field is noisy.
static GATE_STATS: Mutex<GateStats> = Mutex::new(GateStats {
    accepted: 0,
    rejected_confidence: 0,
    rejected_chi: 0,
    rejected_phi_drop: 0,
});

#[derive(Clone, Debug)]
pub struct GateStats {
    pub accepted: u64,
    pub rejected_confidence: u64,
    pub rejected_chi: u64,
    pub rejected_phi_drop: u64,
}

impl GateStats {
    pub fn total_rejected(&self) -> u64 {
        self.rejected_confidence + self.rejected_chi + self.rejected_phi_drop
    }

    pub fn accept_rate(&self) -> f32 {
        let total = self.accepted + self.total_rejected();
        if total == 0 { return 1.0; }
        self.accepted as f32 / total as f32
    }
}

/// Get a snapshot of dream gate statistics.
pub fn gate_stats() -> GateStats {
    GATE_STATS.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

fn push_dream_history(entry: DreamHistoryEntry) {
    let mut history = DREAM_HISTORY.lock().unwrap_or_else(|e| e.into_inner());
    history.push(entry);
    if history.len() > MAX_DREAM_HISTORY {
        history.remove(0);
    }
}

fn get_dream_history() -> Vec<DreamHistoryEntry> {
    DREAM_HISTORY.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Dream result — the output of a single consolidation cycle.
#[derive(Debug, Clone)]
pub struct DreamResult {
    pub concept_a: String,
    pub concept_b: String,
    pub region_a: String,
    pub region_b: String,
    pub overlap: f32,
    pub insight: String,
    pub insight_region: String,
    pub phi_g: f32,
    pub c: f32,
    pub wm: f32,
    pub chi: f32,
    pub duplicate_echo: bool,
    pub is_non_source: bool,
    pub source_reinforcement: f32,
    pub promotion_ready: bool,
}

/// Compute replay priority for a cell.
/// Higher priority = more likely to be picked for dreaming.
/// Factors: low strength (needs reinforcement), novelty, unresolved, cross-region potential.
fn replay_priority(
    _cell_idx: usize,
    cell_strength: f32,
    cell_source: &str,
    cell_created: u64,
    _total_cells: usize,
) -> f32 {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    // Newer cells get slight boost (recently learned)
    let age_days = (now.saturating_sub(cell_created) as f64 / 86400.0) as f32;
    let recency_boost = (-age_days / 30.0_f32).exp();

    // Weak cells need more replay (reinforcement)
    let weakness = (1.0 - (cell_strength / 5.0).min(1.0)) * 0.4;

    // Promoted dreams are interesting to re-explore
    let source_boost = if cell_source == "promoted-dream" { 0.15 } else { 0.0 };

    // Base priority with some randomness for exploration
    let mut rng = rand::thread_rng();
    let noise: f32 = rng.gen_range(0.0..0.15);

    (recency_boost * 0.3 + weakness + source_boost + noise).min(1.0)
}

/// Select the best dream pair from candidate cells.
/// Matches the JS selectDreamPair logic: scores pairs by overlap band,
/// replay priority, cross-region bonus, and duplicate penalty.
fn select_dream_pair(universe: &Universe) -> Option<(usize, usize, f32)> {
    let cells = universe.cells();
    if cells.len() < 2 { return None; }

    // Rank cells by replay priority, take top candidates
    let limit = 14.min(cells.len());
    let mut scored: Vec<(usize, f32)> = cells.iter().enumerate()
        .map(|(i, c)| (i, replay_priority(i, c.strength, &c.source, c.created, cells.len())))
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(limit);

    let mut best: Option<(usize, usize, f32, f32)> = None; // (i, j, overlap, pair_score)

    for ci in 0..scored.len() {
        for cj in (ci + 1)..scored.len() {
            let i = scored[ci].0;
            let j = scored[cj].0;
            let a = &cells[i];
            let b = &cells[j];

            let overlap = a.vec.cosine(&b.vec).max(0.0);

            // Filter: overlap must be in the productive band [0.18, 0.88]
            if overlap < 0.18 || overlap > 0.88 { continue; }

            // Target the 0.52 sweet spot — max information from partial overlap
            let target_band = 1.0 - (overlap - 0.52).abs();

            // Replay priority average
            let replay_mean = (scored[ci].1 + scored[cj].1) / 2.0;

            // Cross-region diversity bonus
            let cross_region = if a.region != b.region { 0.12 } else { 0.0 };

            // Penalize near-duplicates
            let dup_penalty = if overlap > 0.72 { (overlap - 0.72) * 0.65 } else { 0.0 };

            let pair_score = replay_mean * 0.40
                + target_band * 0.28
                + cross_region
                - dup_penalty;

            let is_better = match &best {
                Some((_, _, _, bs)) => pair_score > *bs,
                None => true,
            };
            if is_better {
                best = Some((i, j, overlap, pair_score));
            }
        }
    }

    best.map(|(i, j, overlap, _)| (i, j, overlap))
}

/// Pick the best insight from query results, preferring non-source matches.
fn pick_best_insight(
    hits: &[(&crate::core::universe::Cell, f32)],
    source_a_text: &str,
    source_b_text: &str,
) -> (String, String, f32, bool) {
    // Prefer the strongest non-source match
    for (cell, score) in hits {
        if cell.text.trim() != source_a_text.trim() && cell.text.trim() != source_b_text.trim() {
            return (cell.text.clone(), cell.region.clone(), *score, true);
        }
    }
    // Fall back to best match
    if let Some((cell, score)) = hits.first() {
        return (cell.text.clone(), cell.region.clone(), *score, false);
    }
    ("no strong concept found".to_string(), String::new(), 0.0, false)
}

/// Resonance quality gate thresholds.
///
/// Scales with universe size — a larger, denser field needs stricter gates
/// because noisy bindings have more contradictory material to hook into.
/// A tiny universe (< 50 cells) runs nearly ungated so dreams can bootstrap.
fn quality_gate(cell_count: usize) -> (f32, f32) {
    // Returns (min_confidence, max_chi)
    match cell_count {
        0..=49   => (0.10, 0.70),   // bootstrapping — very lenient
        50..=149 => (0.20, 0.60),   // growing — moderate gate
        150..=499 => (0.28, 0.52),  // mature — normal gate
        500..=999 => (0.32, 0.46),  // large — stricter
        _         => (0.36, 0.42),  // very large — tight gate
    }
}

/// Run a single dream consolidation cycle.
///
/// This is the full JS rshl-lattice.js consolidate() port — with scored pair
/// selection, full field state, source reinforcement, and history tracking.
///
/// Resonance-gated: bindings that produce low confidence or high contradiction
/// are discarded before they can inject χ noise into the field.
pub fn consolidate(universe: &Universe) -> Option<DreamResult> {
    let (idx_a, idx_b, overlap) = select_dream_pair(universe)?;

    let cells = universe.cells();
    let a = &cells[idx_a];
    let b = &cells[idx_b];

    // Bundle the two source vectors
    let synthetic = SparseVec::bundle(&[&a.vec, &b.vec]);

    // Query the universe with the synthetic vec to find the cleanup match
    let hits = universe.query_vec(&synthetic, 5);

    let (insight_text, insight_region, confidence, is_non_source) =
        pick_best_insight(&hits, &a.text, &b.text);

    // ── GATE 1: Pre-field resonance quality check ─────────────────────────
    // If the synthetic bundle doesn't resonate meaningfully with the universe,
    // this is a noise binding. Abort before computing field state — cheap exit.
    // This directly prevents χ injection from low-quality cross-region smashes.
    let (min_confidence, max_chi) = quality_gate(universe.count());
    if confidence < min_confidence {
        if let Ok(mut s) = GATE_STATS.lock() { s.rejected_confidence += 1; }
        return None; // Synthetic doesn't resonate — discard, saves field computation
    }

    // Also discard immediately if the insight is empty or the fallback text
    if insight_text.is_empty() || insight_text == "no strong concept found" {
        if let Ok(mut s) = GATE_STATS.lock() { s.rejected_confidence += 1; }
        return None;
    }

    // Winner key for tau tracking
    let winner_key = insight_text.trim().to_lowercase();

    // Compute full field state
    let source_vecs: Vec<(&SparseVec, f32, u64)> = vec![
        (&a.vec, a.strength, a.created),
        (&b.vec, b.strength, b.created),
    ];

    let history_snapshot = get_dream_history();
    let prev_phi_g = history_snapshot.last().map(|h| h.phi_g).unwrap_or(0.0);
    let field_input = FieldInput {
        synthetic_vec: Some(&synthetic),
        source_vecs,
        candidate_scores: vec![overlap, confidence.max(0.0)],
        goal_vec: None, // Will be set by caller if drive has a goal
        winner_key: winner_key.clone(),
        history: &history_snapshot,
        total_count: universe.count(),
        prev_phi_g,
    };

    let field = FieldState::compute_full(&field_input);

    // ── GATE 2: Post-field contradiction check ────────────────────────────
    // If this specific binding has high inherent contradiction, discard it.
    // This catches cases where the pair scored well geometrically but the
    // resulting field is self-contradictory — exactly the χ spike source.
    if field.chi > max_chi {
        if let Ok(mut s) = GATE_STATS.lock() { s.rejected_chi += 1; }
        return None; // Contradictory binding — discard, prevents χ injection
    }

    // ── GATE 3: Φg delta check ────────────────────────────────────────────
    // If this dream would pull coherence DOWN significantly from the last
    // recorded value, it's doing more harm than good. Skip it.
    // Allow a small drop (0.01) for normal variance but reject sharp dips.
    if prev_phi_g > 0.04 && field.phi_g < prev_phi_g - 0.08 {
        if let Ok(mut s) = GATE_STATS.lock() { s.rejected_phi_drop += 1; }
        return None; // Dream degrades global coherence — discard
    }

    // ── GATE 4: Absolute minimum Φg ──────────────────────────────────────
    // Near-null Φg (< 0.005) means the binding produced essentially zero
    // coherent emergence — not a real idea, just arithmetic noise.
    // Dream #632 (Φg=0.001) was the triggering case for this gate.
    if field.phi_g < 0.005 {
        if let Ok(mut s) = GATE_STATS.lock() { s.rejected_phi_drop += 1; }
        return None; // Zero-emergence dream — discard before any side effects
    }

    // Duplicate echo check
    let duplicate_echo = insight_text.trim() == a.text.trim()
        || insight_text.trim() == b.text.trim();

    // Promotion readiness
    let promotion_ready = !duplicate_echo
        && insight_text != "no strong concept found"
        && confidence >= 0.64
        && field.c >= 0.16
        && field.chi <= 0.45
        && field.phi_g >= 0.03;

    // Source reinforcement based on Wm
    let reinforce_by = if promotion_ready {
        field.wm.max(0.05).min(0.30) * 0.60
    } else if field.wm >= 0.10 {
        field.wm.max(0.02).min(0.08) * 0.20
    } else {
        0.0
    };

    // ── Accept: increment gate stats ──────────────────────────────────────
    if let Ok(mut s) = GATE_STATS.lock() { s.accepted += 1; }

    // Track in dream history
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    push_dream_history(DreamHistoryEntry {
        winner_key,
        phi_g: field.phi_g,
        ts: now,
    });

    Some(DreamResult {
        concept_a: a.text.clone(),
        concept_b: b.text.clone(),
        region_a: a.region.clone(),
        region_b: b.region.clone(),
        overlap,
        insight: insight_text,
        insight_region,
        phi_g: field.phi_g,
        c: field.c,
        wm: field.wm,
        chi: field.chi,
        duplicate_echo,
        is_non_source,
        source_reinforcement: reinforce_by,
        promotion_ready,
    })
}

/// Observe a dream result and feed it into the candidate buffer.
pub fn observe_dream(
    candidates: &mut super::candidates::CandidateBuffer,
    dream: &DreamResult,
) {
    if dream.duplicate_echo { return; }
    if dream.insight.is_empty() || dream.insight == "no strong concept found" { return; }

    candidates.observe(
        &dream.insight,
        dream.phi_g,
        dream.c,
        dream.chi,
        0.0, // confidence placeholder
        dream.is_non_source,
    );
}

/// Apply source reinforcement to dream source cells.
/// Call this after consolidate() with mutable universe access.
pub fn reinforce_dream_sources(
    universe: &mut Universe,
    dream: &DreamResult,
) {
    if dream.source_reinforcement <= 0.0 { return; }

    // Find and reinforce both source cells
    let cells = universe.cells_mut();
    for cell in cells.iter_mut() {
        if cell.text == dream.concept_a || cell.text == dream.concept_b {
            cell.strength = (cell.strength + dream.source_reinforcement).min(5.0);
        }
    }
}
