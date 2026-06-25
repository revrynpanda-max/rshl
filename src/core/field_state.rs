//! Field State — Full RSHL Emergence Metrics
//!
//! Ported from field-state.js. Pure computation, no side effects.
//! Given a set of source cells and a synthetic vector, computes
//! all 17 field metrics that drive dream quality, promotion, and valence.
//!
//! Metrics:
//!   ρ    — field density (active/total)
//!   R    — mean coherence (agreement between concepts)
//!   s    — stability (1 / (1 + stddev(coherence samples)))
//!   g    — goal alignment (resonance with evolving goal vector)
//!   χ    — contradiction pressure (disagreement between sources)
//!   τ    — temporal recurrence (how often this winner recurs in history)
//!   r    — recency weight (exponential decay by age)
//!   u    — average strength (normalized)
//!   q    — novelty (1 - R)
//!   Φ    — raw emergence (ρ × R² × s)
//!   Φc   — contradiction-adjusted (Φ × (1-χ))
//!   Φg   — goal-aligned emergence (Φc × g) — THE KEY METRIC
//!   M    — momentum (Φg - previous Φg)
//! Field State — Full RSHL Emergence Metrics
//!
//! Ported from field-state.js. Pure computation, no side effects.
//! Given a set of source cells and a synthetic vector, computes
//! all 17 field metrics that drive dream quality, promotion, and valence.
//!
//! Metrics:
//!   ρ    — field density (active/total)
//!   R    — mean coherence (agreement between concepts)
//!   s    — stability (1 / (1 + stddev(coherence samples)))
//!   g    — goal alignment (resonance with evolving goal vector)
//!   χ    — contradiction pressure (disagreement between sources)
//!   τ    — temporal recurrence (how often this winner recurs in history)
//!   r    — recency weight (exponential decay by age)
//!   u    — average strength (normalized)
//!   q    — novelty (1 - R)
//!   Φ    — raw emergence (ρ × R² × s)
//!   Φc   — contradiction-adjusted (Φ × (1-χ))
//!   Φg   — goal-aligned emergence (Φc × g) — THE KEY METRIC
//!   M    — momentum (Φg - previous Φg)
//!   X    — contradiction × novelty pressure
//!   C    — commit readiness (Φg × (1-χ) × τ)
//!   Wm   — memory reinforcement weight (Φg × r)
//!   Pr   — replay priority ((1-Φg + χ + q) / 3)
use super::{SparseVec, Universe};
use crate::core::regions::{
    compute_region_core, phi_left, phi_right, Region,
    RegionMetrics, RegionalState,
};
use serde::{Deserialize, Serialize};

/// Resonance floor epsilon for the canonical SRHT kernel g(R)=R^2/(2-R).
/// R is clamped to [R_EPS, 1] so 2-R stays in [1,2) (no division issue; the
/// only pole of g is at R=2, outside the operating domain). Mirrors the
/// emergent floor R_min in SRHT_MASTER_PAPER §2.1.
const R_EPS: f32 = 1e-3;

/// Clamp a value to [0, 1].
fn clamp01(n: f32) -> f32 {
    if !n.is_finite() {
        return 0.0;
    }
    n.clamp(0.0, 1.0)
}

fn mean(v: &[f32]) -> f32 {
    if v.is_empty() {
        return 0.0;
    }
    v.iter().sum::<f32>() / v.len() as f32
}

fn stddev(v: &[f32]) -> f32 {
    if v.len() < 2 {
        return 0.0;
    }
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
    pub rho: f32,   // Field density
    pub r_val: f32, // Mean coherence (R)
    pub s: f32,     // Stability
    pub g: f32,     // Goal alignment
    pub chi: f32,   // Contradiction pressure
    pub tau: f32,   // Temporal recurrence
    pub r: f32,     // Recency weight
    pub u: f32,     // Average strength
    pub q: f32,     // Novelty
    pub phi: f32,   // Raw emergence
    pub phi_c: f32, // Contradiction-adjusted emergence
    pub phi_g: f32, // Goal-aligned emergence — THE KEY METRIC
    pub m_val: f32, // Momentum
    pub x: f32,     // Contradiction × novelty pressure
    pub c: f32,     // Commit readiness
    pub wm: f32,    // Memory reinforcement weight
    pub pr: f32,    // Replay priority
    pub gamma: f32, // Recycling efficiency / vitality
    pub omega_health: f32, // Unified lattice health indicator
    pub regen_score: f32, // Trigger for neurogenesis/pruning

    // Legacy aliases for backward compatibility with drive/lattice
    pub coherence: f32,
    pub mass: f32,
    pub pressure: f32,

    pub regional: RegionalState,
}

/// Input parameters for field state computation.
pub struct FieldInput<'a> {
    /// The synthetic (bound/bundled) vector being evaluated
    pub synthetic_vec: Option<&'a SparseVec>,
    /// Source cells from the universe that matched
    pub source_vecs: Vec<(&'a SparseVec, f32, u64, f32)>, // (vec, strength, created_ts, vitality)
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
    /// Dominant layer ID for scale adjustment
    pub layer_id: u8,
}

impl FieldState {
    /// Compute full field state from inputs — matches JS field-state.js exactly.
    pub fn compute_full(input: &FieldInput) -> Self {
        let n = input.total_count.max(1) as f32;
        let active_count = (input.source_vecs.len()
            + if input.synthetic_vec.is_some() { 1 } else { 0 })
        .max(1) as f32;
        let rho = clamp01(active_count / n);

        // ── Coherence samples ──────────────────────────────────────────
        let mut coherence_samples: Vec<f32> = Vec::new();

        // From candidate scores
        for &s in &input.candidate_scores {
            coherence_samples.push(clamp01(s));
        }

        // Synthetic vec vs each source
        if let Some(syn) = input.synthetic_vec {
            for (src_vec, _, _, _) in &input.source_vecs {
                coherence_samples.push(clamp01(syn.cosine(src_vec)));
            }
        }

        // Pairwise source coherence
        for i in 0..input.source_vecs.len() {
            for j in (i + 1)..input.source_vecs.len() {
                coherence_samples.push(clamp01(
                    input.source_vecs[i].0.cosine(input.source_vecs[j].0),
                ));
            }
        }

        let r_val = clamp01(mean(if coherence_samples.is_empty() {
            &[0.0]
        } else {
            &coherence_samples
        }));
        let s = clamp01(
            1.0 / (1.0
                + stddev(if coherence_samples.is_empty() {
                    &[0.0]
                } else {
                    &coherence_samples
                })),
        );

        // ── Goal alignment ─────────────────────────────────────────────
        let g = if let (Some(goal), Some(syn)) = (input.goal_vec, input.synthetic_vec) {
            clamp01(goal.cosine(syn))
        } else {
            1.0 // Neutral when no goal exists
        };

        // ── Contradiction ──────────────────────────────────────────────
        // Weighted friction: only strong concepts should cause high contradiction.
        let mut pair_disagreement: Vec<(f32, f32)> = Vec::new(); // (disagreement, weight)
        for i in 0..input.source_vecs.len() {
            for j in (i + 1)..input.source_vecs.len() {
                let sim = clamp01(input.source_vecs[i].0.cosine(input.source_vecs[j].0));
                let dis = 1.0 - sim;

                // Weight by both strength and query relevance
                let w_i =
                    input.source_vecs[i].1 * input.candidate_scores.get(i).cloned().unwrap_or(1.0);
                let w_j =
                    input.source_vecs[j].1 * input.candidate_scores.get(j).cloned().unwrap_or(1.0);
                let weight = (w_i * w_j).sqrt();

                pair_disagreement.push((dis, weight));
            }
        }

        let chi = if pair_disagreement.is_empty() {
            0.0
        } else {
            let total_w: f32 = pair_disagreement.iter().map(|p| p.1).sum();
            if total_w > 0.0 {
                pair_disagreement.iter().map(|p| p.0 * p.1).sum::<f32>() / total_w
            } else {
                0.0
            }
        };

        // ── Temporal recurrence (τ) ────────────────────────────────────
        let tau = if input.winner_key.is_empty() {
            0.0
        } else {
            let window = 8;
            let tail_start = if input.history.len() > window {
                input.history.len() - window
            } else {
                0
            };
            let tail = &input.history[tail_start..];
            if tail.is_empty() {
                1.0
            } else {
                let matches = tail
                    .iter()
                    .filter(|h| h.winner_key == input.winner_key)
                    .count();
                clamp01(matches as f32 / tail.len() as f32)
            }
        };

        // ── Recency / strength ─────────────────────────────────────────
        let r = if let Some((_, _, ts, _)) = input.source_vecs.first() {
            recency_weight(*ts)
        } else {
            1.0
        };

        let u = if input.source_vecs.is_empty() {
            0.0
        } else {
            clamp01(mean(
                &input
                    .source_vecs
                    .iter()
                    .map(|(_, str, _, _)| str / 5.0)
                    .collect::<Vec<_>>(),
            ))
        };

        // ── Emergence cascade (SRHT CANONICAL + ENGINE MODULATORS) ──────
        // Reconciled with SRHT_MASTER_PAPER.md §2: the canonical ranking core
        // is C_hat_core = g(R) * (1 - chi)^2  ∈ [0,1] (the score on which the
        // master-paper proofs — Theorems 1 & 2, boundedness — hold). The engine
        // extensions rho, gamma (vitality), f(sigma) (layer scale) and tau are
        // POSITIVE MODULATORS layered on top; being positive scalars they do not
        // change WITHIN-layer ranking, so the proven core is left intact.

        // 0. Recycling Efficiency (gamma) - Mean vitality of source claims (engine modulator)
        let gamma = if input.source_vecs.is_empty() {
            0.0
        } else {
            let sum_vit: f32 = input.source_vecs.iter().map(|s| s.3).sum();
            sum_vit / (input.source_vecs.len() as f32)
        };

        // 1. Scale Adjustment f(sigma) (engine modulator)
        let scale_settings = super::scale_manager::get_settings_for_layer(input.layer_id);
        let f_sigma = scale_settings.scale_factor;

        // 2. Canonical resonance kernel.
        // g(R)=R^2/(2-R), canonical SRHT kernel (SRHT_MASTER_PAPER §2).
        // R is rank-based in (0,1]; clamp to [eps,1] so 2-R stays in [1,2) and
        // there is never a division issue (the only pole of g is at R=2, outside
        // the domain). Replaces the bare R^2 term.
        let r_clamped = r_val.clamp(R_EPS, 1.0);
        let g_kernel = (r_clamped * r_clamped) / (2.0 - r_clamped);

        // 3. Continuous contradiction term (1 - chi)^2.
        // We keep the sigmoid smoothing of chi (chi_dynamic) — that smoothing IS
        // the "continuous chi" the master paper requires (SRHT_MASTER_PAPER §2.1).
        // The contradiction factor is applied ONCE, squared, as (1 - chi)^2;
        // it is no longer split between phi_g and C (which previously produced an
        // implicit ~(1-chi)^2). Careful to avoid an accidental (1-chi)^3.
        let phi_base = clamp01(rho * r_val * s);
        let k = 15.0; // Slope steepness
        let threshold = 0.05; // Resonance threshold for friction drop
        let sigmoid_factor = 1.0 / (1.0 + ((phi_base - threshold) * k).exp());
        let chi_dynamic = chi * sigmoid_factor;
        let chi_penalty = (1.0 - chi_dynamic).max(0.0); // (1 - chi), continuous
        let contradiction_sq = chi_penalty * chi_penalty; // (1 - chi)^2, canonical

        // 4. CANONICAL RANKING CORE — C_hat_core = g(R) * (1 - chi)^2 ∈ [0,1].
        // This is the value on which SRHT_MASTER_PAPER proofs hold (§2.2).
        let c_hat_core = clamp01(g_kernel * contradiction_sq);

        // 5. Engine-modulated emergence (phi_g). The canonical core scaled by the
        // engine's positive modulators rho, gamma, f(sigma), and g (goal alignment).
        // g_kernel already carries the (1-chi)^2 contradiction term, so it is NOT
        // multiplied again here. All modulators are positive scalars and therefore
        // do not alter within-layer ranking of c_hat_core.
        let phi_g = clamp01(c_hat_core * rho * gamma * f_sigma * g);

        // Raw phi for legacy reasons
        let phi_raw = clamp01(rho * r_val * s);
        let phi_c = clamp01(phi_raw * chi_penalty);

        // Momentum
        let m_val = phi_g - input.prev_phi_g;

        // Derived metrics
        // X = chi*(1-R): DIAGNOSTIC-ONLY (SRHT_MASTER_PAPER §2.1, §2.3.1).
        // It MUST NOT be used as a prune gate anywhere — pruning routes through
        // the normalized commit (c / convergence_score) instead.
        let x = clamp01(chi * (1.0 - r_val));
        let q = clamp01(1.0 - r_val);
        // Commit (normalized commit score). Canonical core times the engine
        // modulators rho*gamma*f(sigma)*g (carried in phi_g) and tau:
        //   Commit = C_hat_core * rho * gamma * f(sigma) * g * tau   (SRHT_MASTER_PAPER §2).
        // The contradiction term is already squared inside c_hat_core/phi_g, so we
        // do NOT multiply by (1 - chi) again here (that would yield (1-chi)^3).
        let c = clamp01(phi_g * tau);
        let wm = clamp01(phi_g * r);
        let pr = clamp01(((1.0 - phi_g) + chi + q) / 3.0);

        // 18. Unified Health (omega_health)
        // For a single point, we simplify to phi_g dampened by chi.
        let omega_health = phi_g * (1.0 - chi).max(0.0);

        // 19. Neurogenesis / Regeneration Trigger
        // Score = alpha * chi + beta * (1 - phi_g)
        let regen_score = clamp01(0.5 * chi + 0.5 * (1.0 - phi_g));

        Self {
            rho,
            r_val,
            s,
            g,
            chi,
            tau,
            r,
            u,
            q,
            phi: phi_raw,
            phi_c,
            phi_g,
            m_val,
            x,
            c,
            wm,
            pr,
            gamma,
            omega_health,
            regen_score,
            // Legacy aliases
            coherence: r_val,
            mass: u * n,
            pressure: chi,
            regional: RegionalState::default(),
        }
    }

    /// Measure the field state for a specific synthetic vector and the universe.
    pub fn measure(universe: &Universe, bundle: &SparseVec, layer_id: u8) -> Self {
        let hits = universe.query_vec(bundle, 5);
        let mut candidate_scores = Vec::new();
        let mut source_vecs = Vec::new();

        for (cell, score) in &hits {
            candidate_scores.push(*score);
            source_vecs.push((
                &cell.claim.vec,
                cell.claim.confidence,
                cell.claim.created_at,
                cell.claim.vitality,
            ));
        }

        let input = FieldInput {
            synthetic_vec: Some(bundle),
            source_vecs,
            candidate_scores,
            goal_vec: None,
            winner_key: String::new(),
            history: &[],
            total_count: (hits.len() + 2).max(10),
            prev_phi_g: 0.0,
            layer_id,
        };

        Self::compute_full(&input)
    }

    /// Simple compute from universe only (backward compatible).
    /// Used when you don't have a full FieldInput (e.g., heartbeat status).
    pub fn compute(universe: &Universe, layer_id: u8) -> Self {
        use std::collections::HashMap;
        let cells = universe.cells();
        if cells.is_empty() {
            return Self::default();
        }

        let n = cells.len() as f32;

        // Strided sample — spreads evenly across the full universe
        let sample_limit = 50.min(cells.len());
        let stride = (cells.len() / sample_limit).max(1);

        // ── phi_g: mean pairwise cosine across strided sample (Parallel) ──
        use rayon::prelude::*;
        let (phi_sum, phi_count) = (0..sample_limit)
            .into_par_iter()
            .map(|i| {
                let ci = i * stride;
                let mut local_sum = 0.0f32;
                let mut local_count = 0u32;
                for j in (i + 1)..sample_limit.min(i + 10) {
                    let cj = j * stride;
                    local_sum += cells[ci].claim.vec.cosine(&cells[cj].claim.vec).abs();
                    local_count += 1;
                }
                (local_sum, local_count)
            })
            .reduce(|| (0.0, 0), |a, b| (a.0 + b.0, a.1 + b.1));

        let phi_g = if phi_count > 0 {
            phi_sum / phi_count as f32
        } else {
            0.0
        };

        // ── Group by region in ONE pass to avoid N_regions * N_cells scans ──
        let mut region_map: HashMap<&str, Vec<&crate::core::Cell>> = HashMap::new();
        for cell in cells {
            region_map.entry(&cell.region).or_default().push(cell);
        }

        // ── Coherence within regions (strided per region) ─────────────────
        let mut coh_sum = 0.0f32;
        let mut coh_count = 0u32;
        for rcells in region_map.values() {
            let rsample = 10.min(rcells.len());
            let rstride = (rcells.len() / rsample).max(1);
            for i in 0..rsample {
                let ri = i * rstride;
                for j in (i + 1)..rsample {
                    let rj = j * rstride;
                    coh_sum += rcells[ri].claim.vec.cosine(&rcells[rj].claim.vec).abs();
                    coh_count += 1;
                }
            }
        }
        let coherence = if coh_count > 0 {
            coh_sum / coh_count as f32
        } else {
            0.0
        };
        let mass = cells.iter().map(|c| c.claim.confidence).sum::<f32>() / n;

        // ── Cross-region pressure ─────────────────────────────────────────
        // Uses the middle cell of each region for a more representative sample.
        let region_keys: Vec<&&str> = region_map.keys().collect();
        let mut pr_sum = 0.0f32;
        let mut pr_count = 0u32;
        for i in 0..region_keys.len() {
            for j in (i + 1)..region_keys.len() {
                let a_cells = &region_map[region_keys[i]];
                let b_cells = &region_map[region_keys[j]];

                let a = a_cells.get(a_cells.len() / 2);
                let b = b_cells.get(b_cells.len() / 2);
                if let (Some(a), Some(b)) = (a, b) {
                    let sim = a.claim.vec.cosine(&b.claim.vec);
                    if sim < 0.0 {
                        pr_sum += sim.abs();
                    }
                    pr_count += 1;
                }
            }
        }
        let pressure = if pr_count > 0 {
            pr_sum / pr_count as f32
        } else {
            0.0
        };

        // ── Novelty (q = 1 - R) ─────────────────────────────────────────
        // Populated here so the heartbeat fast path doesn't leave q=0.
        let q = clamp01(1.0 - coherence);

        // ── Density (ρ): avg fraction of non-zero dims across strided sample ─
        // Strided so rho reflects the full field, not just the first 50 cells.
        let rho = if sample_limit > 0 {
            let total_active: usize = (0..sample_limit)
                .map(|i| cells[i * stride].claim.vec.nnz())
                .sum();
            let dim = crate::core::sparse_vec::DIM; // 16384
            let total_dims = sample_limit * dim;
            clamp01(total_active as f32 / total_dims as f32)
        } else {
            0.0
        };

        // ── Stability (s = 1 / (1 + stddev(coherence samples))) ─────────
        // Approximated: in the legacy path we already averaged pairwise sims,
        // so use a simple proxy: higher mean coherence → higher stability.
        let s = clamp01(1.0 / (1.0 + (1.0 - coherence).abs()));

        Self {
            phi_g,
            coherence,
            r_val: coherence,
            rho,
            s,
            q,
            mass,
            pressure,
            chi: pressure,
            ..Self::default()
        }
    }

    pub fn update_regional(
        &mut self,
        state: &SparseVec,
        current_pattern: &SparseVec,
        drive_gain: f32,     // g_L — from drive system
        drive_salience: f32, // s_R — from drive system / novelty
        drive_tau: f32,      // τ_R — temporal factor
    ) {
        // Left
        let (rho_l, r_l, chi_l) = compute_region_core(state, current_pattern, Region::Left);
        let left = RegionMetrics {
            rho: rho_l,
            r: r_l,
            chi: chi_l,
            g: drive_gain,
            s: 0.0,
            tau: 0.0,
            phi: 0.0,
        };
        let phi_l = phi_left(&left);


        // Right
        let (rho_r, r_r, chi_r) = compute_region_core(state, current_pattern, Region::Right);
        let right = RegionMetrics {
            rho: rho_r,
            r: r_r,
            chi: chi_r,
            g: 0.0,
            s: drive_salience,
            tau: drive_tau,
            phi: 0.0,
        };
        let phi_r = phi_right(&right);

        // Cross-hemisphere coherence — approximate via direct cosine of the state vecs
        let cross = (state.cosine(current_pattern).abs()).clamp(0.0, 1.0);
        let chi_diff = (chi_l - chi_r).abs();
        let momentum = self.m_val;

        // Bridge Φ (Ψ_B)
        let bridge = (phi_l * phi_r).sqrt() * (cross / (1.0 + chi_diff)) * (1.0 + momentum * 0.1);

        // Omega: unified awareness
        let omega = (phi_l + phi_r + bridge).min(3.0) / 3.0;

        self.regional = RegionalState {
            left,
            right,
            bridge_phi: bridge,
            r_cross: cross,
            chi_disagreement: chi_diff,
            momentum,
            omega,
        };

        // Propagate phi_g from bridge into field-level metric
        let new_phi = (phi_l + phi_r) * 0.5;
        self.phi = new_phi;
        self.phi_g = (self.phi_g * 0.8 + bridge * 0.2).clamp(0.0, 1.0);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// CAPACITY / HEADROOM GAUGE  (Pass 3, ADDITIVE — changes NO existing value)
// ─────────────────────────────────────────────────────────────────────────────
//
// HONEST FRAMING. The owner's "fractal state-space" number is a COMBINATORIAL
// CAPACITY CEILING — a count of how many distinct sub-network configurations the
// lattice COULD in principle hold (his "score of space that can be filled with
// potential subnetworks"). It is astronomically large by construction and is NOT
// a performance score: a ternary lattice of `cells` cells, each a 16384-dim
// vector with values in {-1,0,+1}, has on the order of 3^(cells * active_dims)
// reachable configurations. We KEEP that ceiling untouched.
//
// What was missing was a *gauge*: of that ceiling, how much is actually FILLED
// right now, and how much HEADROOM remains. `CapacityGauge` provides exactly
// that — `utilization` in [0,1] = current active cells / a meaningful cell
// budget, plus the remaining headroom and (optionally) a recent growth rate.
// This is a fill-level gauge, NOT a quality/performance metric.

/// A small, honest capacity/headroom gauge for the lattice. Additive: it sits
/// ALONGSIDE the existing combinatorial "fractal state-space" ceiling and never
/// modifies any of the 17+ field metrics above.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct CapacityGauge {
    /// Active cells currently in the lattice.
    pub active_cells: u64,
    /// The cell budget this gauge measures against (the lattice's working
    /// ceiling — e.g. the 1,000,000-cell hard cap in universe.rs, or a tuned
    /// soft target). A *gauge denominator*, not the combinatorial ceiling.
    pub cell_budget: u64,
    /// Fraction of the budget filled, in [0,1]. = active_cells / cell_budget.
    pub utilization: f32,
    /// Cells still available before the budget is reached (saturating).
    pub headroom_cells: u64,
    /// Optional recent growth rate in cells/observation (caller-supplied delta
    /// since the last sample). 0.0 when unknown. Cheap, no history kept here.
    pub growth_rate: f32,
    /// log10 of the combinatorial CAPACITY CEILING (how many subnetwork
    /// configurations COULD exist) — kept as a magnitude so it never overflows.
    /// This is the owner's "fractal state-space" number, preserved as context,
    /// NOT a performance score. ~= active_cells * active_dims * log10(3).
    pub ceiling_log10: f64,
}

impl CapacityGauge {
    /// Build the gauge from current counts. `active_cells` is `universe.count()`,
    /// `cell_budget` is the working ceiling to measure against (pass the engine's
    /// 1_000_000 cap, or a tuned soft target). `avg_active_dims` is the mean nnz
    /// per cell (~655 at 4% of 16384); used only to express the combinatorial
    /// ceiling's magnitude. `growth_rate` is an optional cells/sample delta
    /// (pass 0.0 if not tracked). PURE: no allocation, no side effects.
    pub fn new(
        active_cells: u64,
        cell_budget: u64,
        avg_active_dims: f32,
        growth_rate: f32,
    ) -> Self {
        let budget = cell_budget.max(1);
        let utilization = clamp01(active_cells as f32 / budget as f32);
        let headroom_cells = budget.saturating_sub(active_cells);
        // Combinatorial ceiling magnitude: each active dim is one of 3 states.
        // log10(3^(cells*dims)) = cells*dims*log10(3). Stored as a log so the
        // (astronomical) ceiling is representable without overflow.
        const LOG10_3: f64 = 0.477_121_254_719_662_4; // log10(3)
        let ceiling_log10 = (active_cells as f64) * (avg_active_dims as f64) * LOG10_3;
        Self {
            active_cells,
            cell_budget: budget,
            utilization,
            headroom_cells,
            growth_rate,
            ceiling_log10,
        }
    }

    /// Convenience: build straight from a `Universe` count and a budget. Keeps
    /// the engine decoupled (we only need the cell count + a budget), so this is
    /// safe to call from any status/HUD path without touching runtime behavior.
    pub fn from_counts(active_cells: usize, cell_budget: usize) -> Self {
        // Default mean active-dims at the engine's 4% sparsity of DIM=16384.
        let avg_active_dims = (super::sparse_vec::DIM as f32) * super::sparse_vec::SPARSITY;
        Self::new(
            active_cells as u64,
            cell_budget as u64,
            avg_active_dims,
            0.0,
        )
    }
}