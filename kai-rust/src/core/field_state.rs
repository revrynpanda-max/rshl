/// Field State — Full RSHL Emergence Metrics
///
/// Ported from field-state.js. Pure computation, no side effects.
/// Given a set of source cells and a synthetic vector, computes
/// all 17 field metrics that drive dream quality, promotion, and valence.
///
/// Metrics:
///   ρ    — field density (active/total)
///   R    — mean coherence (agreement between concepts)
///   s    — stability (1 / (1 + stddev(coherence samples)))
///   g    — goal alignment (resonance with evolving goal vector)
///   χ    — contradiction pressure (disagreement between sources)
///   τ    — temporal recurrence (how often this winner recurs in history)
///   r    — recency weight (exponential decay by age)
///   u    — average strength (normalized)
///   q    — novelty (1 - R)
///   Φ    — raw emergence (ρ × R² × s)
///   Φc   — contradiction-adjusted (Φ × (1-χ))
///   Φg   — goal-aligned emergence (Φc × g) — THE KEY METRIC
///   M    — momentum (Φg - previous Φg)
///   X    — contradiction × novelty pressure
///   C    — commit readiness (Φg × (1-χ) × τ)
///   Wm   — memory reinforcement weight (Φg × r)
///   Pr   — replay priority ((1-Φg + χ + q) / 3)

use super::{SparseVec, Universe};
use serde::{Deserialize, Serialize};

/// Clamp a value to [0, 1].
fn clamp01(n: f32) -> f32 {
    if !n.is_finite() { return 0.0; }
    n.clamp(0.0, 1.0)
}

fn mean(v: &[f32]) -> f32 {
    if v.is_empty() { return 0.0; }
    v.iter().sum::<f32>() / v.len() as f32
}

fn stddev(v: &[f32]) -> f32 {
    if v.len() < 2 { return 0.0; }
    let m = mean(v);
    let variance = v.iter().map(|x| (x - m).powi(2)).sum::<f32>() / v.len() as f32;
    variance.sqrt()
}

/// Recency weight: exponential decay based on age in seconds.
/// Half-life ≈ 180 days.
fn recency_weight(created_secs: u64) -> f32 {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let age_days = (now.saturating_sub(created_secs) as f64) / 86400.0;
    ((-age_days / 180.0).exp()) as f32
}

/// Dream history entry — tracks winner keys for temporal recurrence (τ).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DreamHistoryEntry {
    pub winner_key: String,
    pub phi_g: f32,
    pub ts: u64,
}

/// Full field state with all 17 metrics.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct FieldState {
    pub rho: f32,       // Field density
    pub r_val: f32,     // Mean coherence (R)
    pub s: f32,         // Stability
    pub g: f32,         // Goal alignment
    pub chi: f32,       // Contradiction pressure
    pub tau: f32,       // Temporal recurrence
    pub r: f32,         // Recency weight
    pub u: f32,         // Average strength
    pub q: f32,         // Novelty
    pub phi: f32,       // Raw emergence
    pub phi_c: f32,     // Contradiction-adjusted emergence
    pub phi_g: f32,     // Goal-aligned emergence — THE KEY METRIC
    pub m_val: f32,     // Momentum
    pub x: f32,         // Contradiction × novelty pressure
    pub c: f32,         // Commit readiness
    pub wm: f32,        // Memory reinforcement weight
    pub pr: f32,        // Replay priority

    // Legacy aliases for backward compatibility with drive/lattice
    pub coherence: f32,
    pub mass: f32,
    pub pressure: f32,
}

/// Input parameters for field state computation.
pub struct FieldInput<'a> {
    /// The synthetic (bound/bundled) vector being evaluated
    pub synthetic_vec: Option<&'a SparseVec>,
    /// Source cells from the universe that matched
    pub source_vecs: Vec<(&'a SparseVec, f32, u64)>, // (vec, strength, created_ts)
    /// Raw similarity scores from the query
    pub candidate_scores: Vec<f32>,
    /// The evolving goal vector from the drive system
    pub goal_vec: Option<&'a SparseVec>,
    /// Winner key for this result (for tau tracking)
    pub winner_key: String,
    /// Dream history for tau computation
    pub history: &'a [DreamHistoryEntry],
    /// Total cell count in the universe
    pub total_count: usize,
    /// Previous phi_g (for momentum)
    pub prev_phi_g: f32,
}

impl FieldState {
    /// Compute full field state from inputs — matches JS field-state.js exactly.
    pub fn compute_full(input: &FieldInput) -> Self {
        let n = input.total_count.max(1) as f32;
        let active_count = (input.source_vecs.len() + if input.synthetic_vec.is_some() { 1 } else { 0 }).max(1) as f32;
        let rho = clamp01(active_count / n);

        // ── Coherence samples ──────────────────────────────────────────
        let mut coherence_samples: Vec<f32> = Vec::new();

        // From candidate scores
        for &s in &input.candidate_scores {
            coherence_samples.push(clamp01(s));
        }

        // Synthetic vec vs each source
        if let Some(syn) = input.synthetic_vec {
            for (src_vec, _, _) in &input.source_vecs {
                coherence_samples.push(clamp01(syn.cosine(src_vec)));
            }
        }

        // Pairwise source coherence
        for i in 0..input.source_vecs.len() {
            for j in (i + 1)..input.source_vecs.len() {
                coherence_samples.push(clamp01(input.source_vecs[i].0.cosine(input.source_vecs[j].0)));
            }
        }

        let r_val = clamp01(mean(if coherence_samples.is_empty() { &[0.0] } else { &coherence_samples }));
        let s = clamp01(1.0 / (1.0 + stddev(if coherence_samples.is_empty() { &[0.0] } else { &coherence_samples })));

        // ── Goal alignment ─────────────────────────────────────────────
        let g = if let (Some(goal), Some(syn)) = (input.goal_vec, input.synthetic_vec) {
            clamp01(goal.cosine(syn))
        } else {
            1.0 // Neutral when no goal exists
        };

        // ── Contradiction ──────────────────────────────────────────────
        let mut pair_disagreement: Vec<f32> = Vec::new();
        for i in 0..input.source_vecs.len() {
            for j in (i + 1)..input.source_vecs.len() {
                pair_disagreement.push(1.0 - clamp01(input.source_vecs[i].0.cosine(input.source_vecs[j].0)));
            }
        }
        let score_disagreement = if !input.candidate_scores.is_empty() {
            mean(&input.candidate_scores.iter().map(|&s| 1.0 - clamp01(s)).collect::<Vec<_>>())
        } else {
            0.0
        };
        let chi = clamp01(mean(&[
            if pair_disagreement.is_empty() { 0.0 } else { mean(&pair_disagreement) },
            score_disagreement,
        ]));

        // ── Temporal recurrence (τ) ────────────────────────────────────
        let tau = if input.winner_key.is_empty() {
            0.0
        } else {
            let window = 8;
            let tail_start = if input.history.len() > window { input.history.len() - window } else { 0 };
            let tail = &input.history[tail_start..];
            if tail.is_empty() {
                1.0
            } else {
                let matches = tail.iter().filter(|h| h.winner_key == input.winner_key).count();
                clamp01(matches as f32 / tail.len() as f32)
            }
        };

        // ── Recency / strength ─────────────────────────────────────────
        let r = if let Some((_, _, ts)) = input.source_vecs.first() {
            recency_weight(*ts)
        } else {
            1.0
        };

        let u = if input.source_vecs.is_empty() {
            0.0
        } else {
            clamp01(mean(&input.source_vecs.iter().map(|(_, str, _)| str / 5.0).collect::<Vec<_>>()))
        };

        // ── Emergence cascade ──────────────────────────────────────────
        let phi = clamp01(rho * r_val.powi(2) * s);
        let phi_c = clamp01(phi * (1.0 - chi));
        let phi_g = clamp01(phi_c * g);

        // Momentum
        let m_val = phi_g - input.prev_phi_g;

        // Derived metrics
        let x = clamp01(chi * (1.0 - r_val));
        let q = clamp01(1.0 - r_val);
        let c = clamp01(phi_g * (1.0 - chi) * tau);
        let wm = clamp01(phi_g * r);
        let pr = clamp01(((1.0 - phi_g) + chi + q) / 3.0);

        Self {
            rho, r_val, s, g, chi, tau, r, u, q,
            phi, phi_c, phi_g,
            m_val, x, c, wm, pr,
            // Legacy aliases
            coherence: r_val,
            mass: u * n,
            pressure: chi,
        }
    }

    /// Simple compute from universe only (backward compatible).
    /// Used when you don't have a full FieldInput (e.g., heartbeat status).
    pub fn compute(universe: &Universe) -> Self {
        let cells = universe.cells();
        if cells.is_empty() {
            return Self::default();
        }

        let n = cells.len() as f32;

        // Sample pairwise similarities
        let mut phi_sum = 0.0f32;
        let mut phi_count = 0u32;
        let sample_limit = 50.min(cells.len());
        for i in 0..sample_limit {
            for j in (i + 1)..sample_limit.min(i + 10) {
                let sim = cells[i].vec.cosine(&cells[j].vec).abs();
                phi_sum += sim;
                phi_count += 1;
            }
        }
        let phi_g = if phi_count > 0 { phi_sum / phi_count as f32 } else { 0.0 };

        // Coherence within regions
        let regions = universe.region_counts();
        let mut coh_sum = 0.0f32;
        let mut coh_count = 0u32;
        for region in regions.keys() {
            let rcells: Vec<_> = cells.iter().filter(|c| c.region == *region).collect();
            for i in 0..rcells.len().min(10) {
                for j in (i + 1)..rcells.len().min(10) {
                    coh_sum += rcells[i].vec.cosine(&rcells[j].vec).abs();
                    coh_count += 1;
                }
            }
        }
        let coherence = if coh_count > 0 { coh_sum / coh_count as f32 } else { 0.0 };
        let mass = cells.iter().map(|c| c.strength).sum::<f32>() / n;

        // Cross-region pressure
        let region_keys: Vec<_> = regions.keys().collect();
        let mut pr_sum = 0.0f32;
        let mut pr_count = 0u32;
        for i in 0..region_keys.len() {
            for j in (i + 1)..region_keys.len() {
                let a_cells: Vec<_> = cells.iter().filter(|c| c.region == *region_keys[i]).collect();
                let b_cells: Vec<_> = cells.iter().filter(|c| c.region == *region_keys[j]).collect();
                if let (Some(a), Some(b)) = (a_cells.first(), b_cells.first()) {
                    let sim = a.vec.cosine(&b.vec);
                    if sim < 0.0 {
                        pr_sum += sim.abs();
                        pr_count += 1;
                    }
                }
            }
        }
        let pressure = if pr_count > 0 { pr_sum / pr_count as f32 } else { 0.0 };

        Self {
            phi_g,
            coherence,
            r_val: coherence,
            mass,
            pressure,
            chi: pressure,
            ..Self::default()
        }
    }
}
