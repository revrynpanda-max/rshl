use crate::core::field_state::{DreamHistoryEntry, FieldInput};
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
use crate::core::{FieldState, SparseVec, Universe};
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
        if total == 0 {
            return 1.0;
        }
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
    DREAM_HISTORY
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
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
    /// Discovery synthesis — a newly-phrased cell the dream cycle
    /// *invented* by noticing that two source cells share concepts but
    /// no existing cell captures that connection well. When `Some`, the
    /// caller should store this text as a new cell via
    /// `store_synthesis()`. This is how KAI grows new understanding
    /// from what he already has.
    pub synthesis: Option<DreamSynthesis>,
}

/// A newly-phrased discovery cell produced by dream consolidation.
/// Stored via `store_synthesis()`, which uses `store_or_reinforce` so
/// repeated same-synthesis discoveries just strengthen the existing
/// synthesis cell instead of duplicating.
#[derive(Debug, Clone)]
pub struct DreamSynthesis {
    pub text: String,
    pub label: String,
    pub region: String,
    pub shared_concepts: Vec<String>,
    pub strength: f32,
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
    let source_boost = if cell_source == "promoted-dream" {
        0.15
    } else {
        0.0
    };

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
    if cells.len() < 2 {
        return None;
    }

    // Rank cells by replay priority, take top candidates
    let limit = 14.min(cells.len());
    let mut scored: Vec<(usize, f32)> = cells
        .iter()
        .enumerate()
        .map(|(i, c)| {
            (
                i,
                replay_priority(i, c.strength, &c.source, c.created, cells.len()),
            )
        })
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
            if overlap < 0.18 || overlap > 0.88 {
                continue;
            }

            // Target the 0.52 sweet spot — max information from partial overlap
            let target_band = 1.0 - (overlap - 0.52).abs();

            // Replay priority average
            let replay_mean = (scored[ci].1 + scored[cj].1) / 2.0;

            // Cross-region diversity bonus
            let cross_region = if a.region != b.region { 0.12 } else { 0.0 };

            // Penalize near-duplicates
            let dup_penalty = if overlap > 0.72 {
                (overlap - 0.72) * 0.65
            } else {
                0.0
            };

            let pair_score = replay_mean * 0.40 + target_band * 0.28 + cross_region - dup_penalty;

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
        if cell.label.trim() != source_a_text.trim() && cell.label.trim() != source_b_text.trim() {
            return (cell.label.clone(), cell.region.clone(), *score, true);
        }
    }
    // Fall back to best match
    if let Some((cell, score)) = hits.first() {
        return (cell.label.clone(), cell.region.clone(), *score, false);
    }
    (
        "no strong concept found".to_string(),
        String::new(),
        0.0,
        false,
    )
}

/// Resonance quality gate thresholds.
///
/// Scales with universe size — a larger, denser field needs stricter gates
/// because noisy bindings have more contradictory material to hook into.
/// A tiny universe (< 50 cells) runs nearly ungated so dreams can bootstrap.
fn quality_gate(cell_count: usize) -> (f32, f32) {
    // Returns (min_confidence, max_chi)
    match cell_count {
        0..=49 => (0.10, 0.70),    // bootstrapping — very lenient
        50..=149 => (0.20, 0.60),  // growing — moderate gate
        150..=499 => (0.28, 0.52), // mature — normal gate
        500..=999 => (0.32, 0.46), // large — stricter
        _ => (0.36, 0.42),         // very large — tight gate
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
        pick_best_insight(&hits, &a.label, &b.label);

    // ── GATE 1: Pre-field resonance quality check ─────────────────────────
    // If the synthetic bundle doesn't resonate meaningfully with the universe,
    // this is a noise binding. Abort before computing field state — cheap exit.
    // This directly prevents χ injection from low-quality cross-region smashes.
    let (min_confidence, max_chi) = quality_gate(universe.count());
    if confidence < min_confidence {
        if let Ok(mut s) = GATE_STATS.lock() {
            s.rejected_confidence += 1;
        }
        return None; // Synthetic doesn't resonate — discard, saves field computation
    }

    // Also discard immediately if the insight is empty or the fallback text
    if insight_text.is_empty() || insight_text == "no strong concept found" {
        if let Ok(mut s) = GATE_STATS.lock() {
            s.rejected_confidence += 1;
        }
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
        if let Ok(mut s) = GATE_STATS.lock() {
            s.rejected_chi += 1;
        }
        return None; // Contradictory binding — discard, prevents χ injection
    }

    // ── GATE 3: Φg delta check ────────────────────────────────────────────
    // If this dream would pull coherence DOWN significantly from the last
    // recorded value, it's doing more harm than good. Skip it.
    // Allow a small drop (0.01) for normal variance but reject sharp dips.
    if prev_phi_g > 0.04 && field.phi_g < prev_phi_g - 0.08 {
        if let Ok(mut s) = GATE_STATS.lock() {
            s.rejected_phi_drop += 1;
        }
        return None; // Dream degrades global coherence — discard
    }

    // ── GATE 4: Absolute minimum Φg ──────────────────────────────────────
    // Near-null Φg (< 0.005) means the binding produced essentially zero
    // coherent emergence — not a real idea, just arithmetic noise.
    // Dream #632 (Φg=0.001) was the triggering case for this gate.
    if field.phi_g < 0.005 {
        if let Ok(mut s) = GATE_STATS.lock() {
            s.rejected_phi_drop += 1;
        }
        return None; // Zero-emergence dream — discard before any side effects
    }

    // Duplicate echo check
    let duplicate_echo =
        insight_text.trim() == a.label.trim() || insight_text.trim() == b.label.trim();

    // Promotion readiness
    let promotion_ready = !duplicate_echo
        && insight_text != "no strong concept found"
        && confidence >= 0.64
        && field.c >= 0.16
        && field.chi <= 0.45
        && field.phi_g >= 0.03;

    // ── DISCOVERY SYNTHESIS ─────────────────────────────────────────────
    //
    // Beyond picking an existing insight cell, check whether this
    // dream pairing reveals a *new* connection that isn't captured by
    // any existing cell. The gate is narrow on purpose:
    //
    //   - The existing best-match confidence is only moderate
    //     (0.25..0.60) — good enough to prove the bundle is
    //     meaningful, but not good enough to mean an existing cell
    //     already states this insight.
    //   - The two source cells share at least two significant concept
    //     words at the surface level — i.e. they're really about
    //     related things, not a random collision.
    //   - Field chi is low enough that the pairing isn't just noise.
    //
    // When those all hold, we synthesize a short statement naming
    // the connection and return it so the caller can store it as a
    // brand-new cell in the lattice. That cell then participates in
    // future retrievals and future dreams — classic associative
    // branching.
    let synthesis = if !duplicate_echo
        && confidence >= 0.25
        && confidence < 0.60
        && field.chi <= 0.35
        && field.phi_g >= 0.02
    {
        let shared = shared_concept_words(&a.label, &b.label);
        if shared.len() >= 2 {
            let text = build_synthesis_text(&a.label, &b.label, &shared);
            Some(DreamSynthesis {
                label: text.clone(),
                text,
                region: "synthesis".to_string(),
                shared_concepts: shared,
                strength: 1.0,
            })
        } else {
            None
        }
    } else {
        None
    };

    // Source reinforcement based on Wm
    let reinforce_by = if promotion_ready {
        field.wm.max(0.05).min(0.30) * 0.60
    } else if field.wm >= 0.10 {
        field.wm.max(0.02).min(0.08) * 0.20
    } else {
        0.0
    };

    // ── Accept: increment gate stats ──────────────────────────────────────
    if let Ok(mut s) = GATE_STATS.lock() {
        s.accepted += 1;
    }

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
        concept_a: a.label.clone(),
        concept_b: b.label.clone(),
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
        synthesis,
    })
}

/// Return the set of significant words that appear in BOTH texts.
/// Stopwords and short words are dropped; remaining words are
/// lowercased and deduplicated. This is the surface-level overlap
/// check used by discovery synthesis — it proves the two source
/// cells really are about related things, not a coincidental
/// vector collision.
fn shared_concept_words(a: &str, b: &str) -> Vec<String> {
    const STOPWORDS: &[&str] = &[
        "the", "and", "but", "for", "nor", "yet", "all", "any", "are",
        "can", "did", "does", "doesn", "don", "each", "from", "had",
        "has", "have", "here", "how", "its", "just", "like", "more",
        "most", "much", "may", "might", "must", "not", "now", "off",
        "often", "only", "other", "our", "out", "over", "own", "same",
        "she", "should", "some", "such", "than", "that", "their",
        "them", "then", "there", "these", "they", "this", "those",
        "through", "too", "under", "very", "was", "were", "what", "when",
        "where", "which", "while", "who", "why", "will", "with", "would",
        "you", "your", "being", "because", "however", "therefore",
        "about", "also", "usually", "typically", "often", "many",
        "several", "various", "some", "example", "examples", "called",
        "known", "into", "using", "used", "based", "between", "within",
        "means", "refers",
    ];
    let normalize = |s: &str| -> std::collections::HashSet<String> {
        s.split(|c: char| !c.is_alphanumeric())
            .map(|w| w.trim().to_lowercase())
            .filter(|w| {
                w.len() >= 4
                    && w.chars().all(|c| c.is_alphabetic())
                    && !STOPWORDS.contains(&w.as_str())
            })
            .collect()
    };
    let sa = normalize(a);
    let sb = normalize(b);
    let mut shared: Vec<String> = sa.intersection(&sb).cloned().collect();
    shared.sort(); // Stable ordering for reproducibility
    shared
}

/// Build the synthesis statement for a newly-discovered connection.
///
/// The text is deliberately short and factual. It names the shared
/// concepts and gestures at both sources without quoting them fully
/// (long cells make retrieval noisier). The resulting cell reads as
/// a compressed claim about what connects two prior pieces of
/// knowledge — the kind of insight you'd expect after a night's
/// thought.
fn build_synthesis_text(a: &str, b: &str, shared: &[String]) -> String {
    let concept_phrase = match shared.len() {
        0 => return String::new(), // caller already filters this
        1 => shared[0].clone(),
        2 => format!("{} and {}", shared[0], shared[1]),
        _ => format!(
            "{}, {}, and {}",
            shared[0],
            shared[1],
            shared[2..].join(", ")
        ),
    };

    // Produce a short gloss of each source: first ~8 words, no trailing period.
    let gloss = |s: &str| -> String {
        let trimmed = s.trim_end_matches(|c: char| matches!(c, '.' | '!' | '?'));
        let words: Vec<&str> = trimmed.split_whitespace().take(8).collect();
        let mut g = words.join(" ");
        // If we truncated, add an ellipsis so the gloss is honest
        if trimmed.split_whitespace().count() > 8 {
            g.push('…');
        }
        g
    };

    format!(
        "The concept of {} connects '{}' with '{}'.",
        concept_phrase,
        gloss(a),
        gloss(b)
    )
}

/// Apply a dream's discovery synthesis to the universe. Creates the
/// synthesis cell via `store_or_reinforce`, so re-discovery of the
/// same connection strengthens the existing cell instead of spawning
/// duplicates. Returns true if a new cell was created.
pub fn store_synthesis(universe: &mut Universe, dream: &DreamResult) -> bool {
    let Some(syn) = dream.synthesis.as_ref() else {
        return false;
    };
    if syn.label.is_empty() {
        return false;
    }
    universe.store_or_reinforce(&syn.label, &syn.region, "dream-discovery", syn.strength)
}

/// Observe a dream result and feed it into the candidate buffer.
pub fn observe_dream(candidates: &mut super::candidates::CandidateBuffer, dream: &DreamResult) {
    if dream.duplicate_echo {
        return;
    }
    if dream.insight.is_empty() || dream.insight == "no strong concept found" {
        return;
    }

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
pub fn reinforce_dream_sources(universe: &mut Universe, dream: &DreamResult) {
    if dream.source_reinforcement <= 0.0 {
        return;
    }

    // Find and reinforce both source cells
    let cells = universe.cells_mut();
    for cell in cells.iter_mut() {
        if cell.label == dream.concept_a || cell.label == dream.concept_b {
            cell.strength = (cell.strength + dream.source_reinforcement).min(5.0);
        }
    }
}

