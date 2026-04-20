// core/regions.rs
// Four-region extension for RSHL: Left/Right/Bridge/Global awareness.
// Implements Φ_L, Φ_R, Ψ_B, Ω from the notebook math.

use crate::core::sparse_vec::SparseVec;

pub const DIM: usize = 4096;
pub const REGION_DIM: usize = 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Region {
    Left = 0,   // logic, structure, gain-driven
    Right = 1,  // associative, salience + temporal
    Bridge = 2, // cross-hemisphere binding
    Global = 3, // unified awareness
}

impl Region {
    #[inline]
    pub fn range(self) -> std::ops::Range<usize> {
        let start = (self as usize) * REGION_DIM;
        start..(start + REGION_DIM)
    }

    #[inline]
    pub fn from_index(i: usize) -> Region {
        match i / REGION_DIM {
            0 => Region::Left,
            1 => Region::Right,
            2 => Region::Bridge,
            _ => Region::Global,
        }
    }

    pub fn all() -> [Region; 4] {
        [Region::Left, Region::Right, Region::Bridge, Region::Global]
    }
}

/// Per-region core metrics. Mirrors the four Φg variables but scoped to 1024 dims.
#[derive(Clone, Copy, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct RegionMetrics {
    pub rho: f32, // density within this region's 1024 dims
    pub r: f32,   // resonance computed over active positions in region
    pub chi: f32, // contradiction within region's active state
    pub g: f32,   // gain (Left) — driven by input/drive
    pub s: f32,   // salience (Right) — novelty-driven
    pub tau: f32, // temporal factor (Right)
    pub phi: f32, // computed Φ value for this region
}

/// Full four-region state, computed each tick alongside global Φg.
#[derive(Clone, Copy, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct RegionalState {
    pub left: RegionMetrics,
    pub right: RegionMetrics,
    pub bridge_phi: f32,       // Ψ_B
    pub r_cross: f32,          // cross-hemisphere resonance
    pub chi_disagreement: f32, // |χ_L − χ_R|
    pub momentum: f32,         // M term in Ψ_B (pulled from global field)
    pub omega: f32,            // Ω unified awareness signal
}

// ============================================================================
// Core computations — direct from notebook
// ============================================================================

/// Φ_L = ρ_L × R_L² × (1 − χ_L) × g_L
#[inline]
pub fn phi_left(m: &RegionMetrics) -> f32 {
    m.rho * m.r * m.r * (1.0 - m.chi) * m.g
}

/// Φ_R = ρ_R × R_R² × s_R × τ_R
#[inline]
pub fn phi_right(m: &RegionMetrics) -> f32 {
    m.rho * m.r * m.r * m.s * m.tau
}

/// Ψ_B = Bundle(SelectTop(Φ_L, k), SelectTop(Φ_R, k))
///       × (R_cross / (1 + |χ_L − χ_R|))
///       × M
///
/// Scalar form: the "Bundle × SelectTop" contribution is approximated as
/// the geometric mean of Φ_L and Φ_R weighted by R_cross with disagreement damping.
/// If you want the full vector bundle, see `bridge_vector()` below.
#[inline]
pub fn psi_bridge(
    phi_l: f32,
    phi_r: f32,
    r_cross: f32,
    chi_l: f32,
    chi_r: f32,
    momentum: f32,
) -> f32 {
    let chi_diff = (chi_l - chi_r).abs();
    let disagreement_damp = r_cross / (1.0 + chi_diff);
    let joint = (phi_l * phi_r).sqrt(); // geometric mean — symmetric, 0 if either is 0
    joint * disagreement_damp * momentum
}

/// Ω = ((Φ_L + Φ_R + Ψ_B) / 3) × (1 − |χ_L − χ_R| / 2)
#[inline]
pub fn omega(phi_l: f32, phi_r: f32, psi_b: f32, chi_l: f32, chi_r: f32) -> f32 {
    let mean = (phi_l + phi_r + psi_b) / 3.0;
    let coherence = 1.0 - (chi_l - chi_r).abs() / 2.0;
    mean * coherence.max(0.0)
}

// ============================================================================
// Vector-level ops — for when you want the actual Bridge pattern, not just a scalar
// ============================================================================

/// Select the top-k highest-magnitude positions from a region's slice of the
/// lattice state. Returns (index_in_region, signed_value) pairs.
pub fn select_top_k(state: &SparseVec, region: Region, k: usize) -> Vec<(usize, i8)> {
    let range = region.range();
    let mut scored: Vec<(usize, i8)> = range
        .clone()
        .filter_map(|i| {
            let v = state.data[i];
            if v != 0 {
                Some((i - range.start, v))
            } else {
                None
            }
        })
        .collect();
    // Sort by absolute value descending; ties broken by index
    scored.sort_by(|a, b| b.1.abs().cmp(&a.1.abs()).then(a.0.cmp(&b.0)));
    scored.truncate(k);
    scored
}

/// Bundle two top-k selections into a single 1024-dim ternary pattern.
/// Sign-preserving: +1 + +1 → +1, +1 + −1 → 0, −1 + −1 → −1.
pub fn bundle_top_k(left_top: &[(usize, i8)], right_top: &[(usize, i8)]) -> [i8; REGION_DIM] {
    let mut out = [0i8; REGION_DIM];
    for &(i, v) in left_top.iter().chain(right_top.iter()) {
        let sum = out[i] as i32 + v as i32;
        out[i] = sum.clamp(-1, 1) as i8;
    }
    out
}

/// Cross-hemisphere resonance: cosine over active positions of the two top-k bundles.
pub fn r_cross(left_top: &[(usize, i8)], right_top: &[(usize, i8)]) -> f32 {
    use std::collections::HashMap;
    let mut l_map: HashMap<usize, i8> = HashMap::new();
    for &(i, v) in left_top {
        l_map.insert(i, v);
    }

    let mut dot: i32 = 0;
    let mut l_norm: i32 = 0;
    let mut r_norm: i32 = 0;

    for &(_, v) in left_top {
        l_norm += (v as i32) * (v as i32);
    }
    for &(i, v) in right_top {
        r_norm += (v as i32) * (v as i32);
        if let Some(&lv) = l_map.get(&i) {
            dot += (lv as i32) * (v as i32);
        }
    }
    let denom = ((l_norm as f32) * (r_norm as f32)).sqrt();
    if denom < 1e-6 {
        0.0
    } else {
        (dot as f32) / denom
    }
}

// ============================================================================
// Per-region metric computation from the lattice state
// ============================================================================

/// Compute ρ, R, χ for a region given the current lattice state + the "current pattern"
/// you already use in field_state.rs. The g/s/τ terms come from the drive system
/// and get injected by the caller.
pub fn compute_region_core(
    state: &SparseVec,
    current_pattern: &SparseVec,
    region: Region,
) -> (f32, f32, f32) {
    let range = region.range();

    // ρ: active / REGION_DIM
    let mut active = 0u32;
    let mut dot: i32 = 0;
    let mut s_norm: i32 = 0;
    let mut p_norm: i32 = 0;
    let mut conflicts = 0u32;

    for i in range {
        let sv = state.data[i];
        let pv = current_pattern.data[i];
        if sv != 0 {
            active += 1;
            s_norm += 1; // ternary: sv² is always 1 when active
        }
        if pv != 0 {
            p_norm += 1;
        }
        if sv != 0 && pv != 0 {
            dot += (sv as i32) * (pv as i32);
            // contradiction: opposing signs at the same position
            if sv.signum() != pv.signum() {
                conflicts += 1;
            }
        }
    }

    let rho = (active as f32) / (REGION_DIM as f32);

    let r = if s_norm == 0 || p_norm == 0 {
        0.0
    } else {
        (dot as f32) / ((s_norm as f32) * (p_norm as f32)).sqrt()
    };

    let chi = if active == 0 {
        0.0
    } else {
        (conflicts as f32) / (active as f32)
    };

    (rho, r, chi)
}
