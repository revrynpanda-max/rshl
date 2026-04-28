use crate::core::field_state::DreamHistoryEntry;
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
#[allow(dead_code)]
static DREAM_HISTORY: Mutex<Vec<DreamHistoryEntry>> = Mutex::new(Vec::new());
#[allow(dead_code)]
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

#[allow(dead_code)]
fn push_dream_history(entry: DreamHistoryEntry) {
    let mut history = DREAM_HISTORY.lock().unwrap_or_else(|e| e.into_inner());
    history.push(entry);
    if history.len() > MAX_DREAM_HISTORY {
        history.remove(0);
    }
}

#[allow(dead_code)]
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
    pub strength: f32,
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
    pub vec: crate::core::SparseVec,
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
                replay_priority(
                    i,
                    c.claim.confidence,
                    &c.claim.source,
                    c.claim.created_at,
                    cells.len(),
                ),
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

            let overlap = a.claim.vec.phasor_coherence(&b.claim.vec);

            // Filter: allow resonance above 0.18 (including phase-aligned negative torsion)
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
#[allow(dead_code)]
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
#[allow(dead_code)]
fn quality_gate(cell_count: usize) -> (f32, f32) {
    // Returns (min_confidence, max_chi)
    match cell_count {
        0..=49 => (0.05, 0.98),    // bootstrapping — very lenient
        50..=149 => (0.08, 0.98),  // growing — moderate gate
        150..=499 => (0.08, 0.95), // mature — normal gate
        500..=999 => (0.08, 0.95), // large — relaxed for theory digestion
        _ => (0.05, 0.98),         // very large — lenient to allow HLV resonance
    }
}

/// Run a single dream consolidation cycle.
///
/// Targeted variant of consolidate that forces a dream between two specific cells.
/// /// Useful for digestion phases where we want to "weave" a specific region.
pub fn consolidate_pair(
    universe: &Universe,
    idx_a: usize,
    idx_b: usize,
    _goal: Option<&crate::core::SparseVec>,
) -> Option<DreamResult> {
    let cells = universe.cells();
    if idx_a >= cells.len() || idx_b >= cells.len() {
        return None;
    }
    let a = &cells[idx_a];
    let b = &cells[idx_b];

    // Only connect meaningful, high-quality cells
    if a.claim.confidence < 1.8 || b.claim.confidence < 1.8 {
        return None;
    }

    let bundle = SparseVec::bundle(&[&a.claim.vec, &b.claim.vec]);

    // Find resonance
    let hits = universe.query_vec(&bundle, 1);
    if hits.is_empty() {
        return None;
    }
    let (best_cell, resonance) = &hits[0];

    // Much stricter gate — only strong resonances get bridges
    if *resonance < 0.22 {
        return None;
    }

    let field = FieldState::measure(universe, &bundle);

    // Only create bridge if the resulting field is high quality
    if field.phi_g < 1.2 || field.chi > 0.45 {
        return None;
    }

    // Bridges are born strong: average of parents * 0.85
    let birth_strength = (a.claim.confidence + b.claim.confidence) / 2.0 * 0.85;

    // Synthesis
    let shared = shared_concept_words(&a.claim.text, &b.claim.text);
    let synthesis_vec = bundle.clone();

    let (label, text) = if shared.len() >= 1 {
        let t = build_synthesis_text(&a.claim.text, &b.claim.text, &shared);
        (t.clone(), t)
    } else {
        let t = format!("[Bridge] {} ↔ {}", a.claim.text, b.claim.text);
        (t.clone(), t)
    };

    Some(DreamResult {
        concept_a: a.label.clone(),
        concept_b: b.label.clone(),
        region_a: a.region.clone(),
        region_b: b.region.clone(),
        overlap: *resonance,
        insight: best_cell.label.clone(),
        insight_region: best_cell.region.clone(),
        phi_g: field.phi_g,
        c: *resonance,
        wm: field.wm,
        chi: field.chi,
        duplicate_echo: false,
        is_non_source: true,
        source_reinforcement: 0.15,
        promotion_ready: true,
        strength: birth_strength,
        synthesis: Some(DreamSynthesis {
            label,
            text,
            region: "synthesis".to_string(),
            shared_concepts: shared,
            strength: birth_strength,
            vec: synthesis_vec,
        }),
    })
}

pub fn consolidate(universe: &Universe) -> Option<DreamResult> {
    let (idx_a, idx_b, _overlap) = select_dream_pair(universe)?;
    consolidate_pair(universe, idx_a, idx_b, None)
}

/// Return the set of significant words that appear in BOTH texts.
/// Stopwords and short words are dropped; remaining words are
/// lowercased and deduplicated. This is the surface-level overlap
/// check used by discovery synthesis — it proves the two source
/// cells really are about related things, not a coincidental
/// vector collision.
fn shared_concept_words(a: &str, b: &str) -> Vec<String> {
    const STOPWORDS: &[&str] = &[
        "the",
        "and",
        "but",
        "for",
        "nor",
        "yet",
        "all",
        "any",
        "are",
        "can",
        "did",
        "does",
        "doesn",
        "don",
        "each",
        "from",
        "had",
        "has",
        "have",
        "here",
        "how",
        "its",
        "just",
        "like",
        "more",
        "most",
        "much",
        "may",
        "might",
        "must",
        "not",
        "now",
        "off",
        "often",
        "only",
        "other",
        "our",
        "out",
        "over",
        "own",
        "same",
        "she",
        "should",
        "some",
        "such",
        "than",
        "that",
        "their",
        "them",
        "then",
        "there",
        "these",
        "they",
        "this",
        "those",
        "through",
        "too",
        "under",
        "very",
        "was",
        "were",
        "what",
        "when",
        "where",
        "which",
        "while",
        "who",
        "why",
        "will",
        "with",
        "would",
        "you",
        "your",
        "being",
        "because",
        "however",
        "therefore",
        "about",
        "also",
        "usually",
        "typically",
        "often",
        "many",
        "several",
        "various",
        "some",
        "example",
        "examples",
        "called",
        "known",
        "into",
        "using",
        "used",
        "based",
        "between",
        "within",
        "means",
        "refers",
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
    // Convergence score is inverse of contradiction (chi).
    // High chi (contradiction) -> low convergence score -> flags FID.
    let conv_score = (1.0 / (0.1 + dream.chi)).min(9.99);

    universe.store_or_reinforce_with_vec(
        &syn.label,
        &syn.region,
        "dream-discovery",
        syn.strength,
        Some(syn.vec.clone()),
        Some(conv_score),
    )
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
            cell.claim.confidence = (cell.claim.confidence + dream.source_reinforcement).min(5.0);
        }
    }
}

// KAI v6.0.0
