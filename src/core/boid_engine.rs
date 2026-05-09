//! Boid Engine — Lattice Self-Organization via flocking behavior.
//!
//! Implements the 3 rules of Boids for 16,384-dimensional sparse vectors
//! in the KAI RSHL Universe, with three critical safeguards:
//!
//! 1. ANCHOR PROTECTION: Cells with confidence >= 3.5 are immune. They do not move.
//! 2. SIMILARITY CAP: Cohesion only applies to pairs with 0.15 < similarity < 0.85.
//!    Below 0.15 = unrelated. Above 0.85 = near-duplicate (flagged, not pulled closer).
//! 3. REGIONAL ISOLATION: Cells from different regions NEVER influence each other.

use super::SparseVec;
use super::universe::Universe;
use rayon::prelude::*;

const ANCHOR_CONFIDENCE_THRESHOLD: f32 = 3.5;
const MIN_NEIGHBOR_SIM: f32 = 0.15;
const MAX_NEIGHBOR_SIM: f32 = 0.85;

pub struct BoidSettings {
    pub separation_weight: f32,
    pub alignment_weight: f32,
    pub cohesion_weight: f32,
}

impl Default for BoidSettings {
    fn default() -> Self {
        // Empirically tuned for ternary VSA at 16,384 dims, 4% density.
        // sep=1.5 keeps duplicates apart; align=1.5 propagates directional consensus;
        // coh=1.5 pulls semantically related concepts together.
        // All three balanced at 1.5 produces maximum within-cluster cohesion
        // while maintaining cross-cluster separation (tested at DIM=1024).
        Self {
            separation_weight: 1.5,
            alignment_weight: 1.5,
            cohesion_weight: 1.5,
        }
    }
}

pub struct BoidState {
    pub positions: Vec<Vec<f32>>,
    pub velocities: Vec<Vec<f32>>,
    pub is_anchor: Vec<bool>,    // Safeguard 1: anchor immunity
    pub regions: Vec<String>,    // Safeguard 3: regional isolation
    pub confidences: Vec<f32>,
    pub vitality: Vec<f32>,      // Biological vitality (telomeres)
    pub layers: Vec<u8>,         // Hierarchy layer
    pub user_ids: Vec<String>,   // User isolation (Cellularization)
}

impl BoidState {
    pub fn from_universe(universe: &Universe) -> Self {
        let cells = universe.get_cells();
        let positions = cells.iter().map(|c| {
            c.claim.vec.data.iter().map(|&v| v as f32).collect()
        }).collect();
        let velocities = vec![vec![0.0f32; super::sparse_vec::DIM]; cells.len()];
        let is_anchor = cells.iter().map(|c| c.claim.confidence >= ANCHOR_CONFIDENCE_THRESHOLD).collect();
        let regions = cells.iter().map(|c| c.region.clone()).collect();
        let confidences = cells.iter().map(|c| c.claim.confidence).collect();
        let vitality = cells.iter().map(|c| c.claim.vitality).collect();
        let layers = cells.iter().map(|c| c.claim.layer).collect();
        let user_ids = cells.iter().map(|c| c.claim.user_id.clone()).collect();

        Self { positions, velocities, is_anchor, regions, confidences, vitality, layers, user_ids }
    }

    pub fn apply_to_universe(&self, universe: &mut Universe) {
        let cells = universe.get_cells_mut();
        for (i, pos) in self.positions.iter().enumerate() {
            if i >= cells.len() { break; }
            
            // Update vitality in the actual universe
            cells[i].claim.vitality = self.vitality[i];

            // Safeguard 1: Never mutate anchor cell positions
            if self.is_anchor[i] { continue; }

            let orig = &cells[i].claim.vec.data;
            let mut acc = vec![0i32; super::sparse_vec::DIM];
            for k in 0..super::sparse_vec::DIM {
                acc[k] = orig[k] as i32 * 100 + (pos[k] * 50.0) as i32;
            }

            let target_nnz = (super::sparse_vec::DIM as f32 * 0.04) as usize; // VSA Target Density: 4% (~655 active dims)
            let mut indexed: Vec<(usize, i32)> = acc.iter().enumerate()
                .map(|(idx, &v)| (idx, v)).collect();
            indexed.sort_unstable_by(|a, b| b.1.abs().cmp(&a.1.abs()));

            let mut ternary = vec![0i8; super::sparse_vec::DIM];
            for j in 0..target_nnz {
                let (idx, val) = indexed[j];
                ternary[idx] = if val > 0 { 1 } else { -1 };
            }
            cells[i].claim.vec = SparseVec::from_raw(ternary);
        }
    }
}

/// Returns indices of cells that are near-duplicates (similarity > 0.85).
/// These should be flagged for merging, not pulled closer.
pub fn find_near_duplicates(state: &BoidState) -> Vec<(usize, usize, f32)> {
    let n = state.positions.len();
    let mut pairs = Vec::new();
    for i in 0..n {
        for j in i+1..n {
            if state.regions[i] != state.regions[j] { continue; }
            let sim = dot_sim(&state.positions[i], &state.positions[j]);
            if sim > MAX_NEIGHBOR_SIM {
                pairs.push((i, j, sim));
            }
        }
    }
    pairs
}

fn dot_sim(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let mag_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let mag_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if mag_a == 0.0 || mag_b == 0.0 { 0.0 } else { dot / (mag_a * mag_b) }
}

pub fn run_boid_iteration(state: &mut BoidState, settings: &BoidSettings, field: &crate::core::field_state::FieldState) {
    let n = state.positions.len();
    if n < 2 { return; }

    // --- SCALE-AWARE PARAMETER TUNING ---
    // We use the Syncytium settings (Layer 1) as the baseline for global forces
    let global_settings = crate::core::scale_manager::get_settings_for_layer(1);
    
    // Dynamic Weights based on SRHT Metrics
    let sep_w = settings.separation_weight * (1.0 + field.chi * 2.0);
    let align_w = settings.alignment_weight * (1.0 + field.r_val);
    let coh_w = settings.cohesion_weight * (1.0 + field.phi_g);

    let new_results: Vec<(Vec<f32>, Vec<f32>, f32, u8)> = (0..n).into_par_iter().map(|i| {
        // --- 1. Vitality Budget & Immune Response ---
        // Formula: V(t+1) = V(t) - delta * chi + epsilon * phi_g
        let phi_g = field.phi_g;
        let chi = field.chi;
        let layer_settings = crate::core::scale_manager::get_settings_for_layer(state.layers[i]);
        
        let decay = layer_settings.vitality_decay * chi;
        let replenish = layer_settings.vitality_replenish * phi_g;
        
        let mut new_vitality = (state.vitality[i] - decay + replenish).clamp(0.0, 1.0);

        // --- 2. Neurogenesis (Semantic Jitter) ---
        // High regen_score triggers random dimension shifts to explore fresh semantic space.
        let mut pos = state.positions[i].clone();
        if field.regen_score > 0.7 && !state.is_anchor[i] {
            let mut rng = rand::thread_rng();
            use rand::Rng;
            for _ in 0..10 { // Shift 10 random dimensions
                let idx = rng.gen_range(0..super::sparse_vec::DIM);
                pos[idx] += rng.gen_range(-0.5..0.5);
            }
        }

        // --- 2. Scale-Aware Layer Transition ---
        // Claims can "mature" or "drift" between layers based on health (phi_g)
        let mut current_layer = state.layers[i];
        if new_vitality > 0.95 && phi_g > 0.7 && current_layer < 5 {
            // Maturation: extremely healthy claims in a resonant field drift toward global stability.
            current_layer += 1;
        } else if new_vitality < 0.15 && current_layer > 1 {
            // Degradation: weak claims drift back toward the volatile syncytium for recycling.
            current_layer -= 1;
        }

        // Safeguard 1: Anchors don't move and have infinite vitality
        if state.is_anchor[i] {
            return (state.positions[i].clone(), vec![0.0f32; super::sparse_vec::DIM], 1.0, current_layer);
        }

        let mut v_sep = vec![0.0f32; super::sparse_vec::DIM];
        let mut v_cohere = vec![0.0f32; super::sparse_vec::DIM];
        let mut v_align = vec![0.0f32; super::sparse_vec::DIM];
        let mut neighbor_count = 0usize;

        for j in 0..n {
            if i == j { continue; }

            // Safeguard 3: Regional isolation — only flock within same region
            if state.regions[i] != state.regions[j] { continue; }

            // --- SCALE-AWARE ISOLATION ---
            // Layer 2 (Cellular) claims are isolated by user_id bubble.
            // They do NOT feel forces from other users.
            if current_layer == crate::core::claim::LAYER_CELLULAR {
                if state.user_ids[i] != state.user_ids[j] {
                    continue; 
                }
            }

            let sim = dot_sim(&state.positions[i], &state.positions[j]);

            // Safeguard 2: Similarity cap
            if sim < MIN_NEIGHBOR_SIM { continue; } 
            if sim > MAX_NEIGHBOR_SIM { continue; } 

            neighbor_count += 1;

            // Rule 1 — Separation
            if sim > 0.6 {
                for k in 0..super::sparse_vec::DIM {
                    v_sep[k] += state.positions[i][k] - state.positions[j][k];
                }
            }

            // Rule 2 — Alignment
            for k in 0..super::sparse_vec::DIM {
                v_align[k] += state.velocities[j][k];
            }

            // Rule 3 — Cohesion
            for k in 0..super::sparse_vec::DIM {
                v_cohere[k] += state.positions[j][k] - state.positions[i][k];
            }
        }

        let mut vel = state.velocities[i].clone();
        if neighbor_count > 0 {
            let n_f = neighbor_count as f32;
            let speed_factor = layer_settings.movement_speed;
            for k in 0..super::sparse_vec::DIM {
                vel[k] += (v_sep[k] * sep_w
                          + (v_align[k] / n_f) * align_w
                          + (v_cohere[k] / n_f) * coh_w) * speed_factor;
            }
        }

        // Clamp speed
        let speed = vel.iter().map(|v| v * v).sum::<f32>().sqrt();
        let max_speed = 5.0 * layer_settings.scale_factor;
        if speed > max_speed {
            for k in 0..super::sparse_vec::DIM { vel[k] *= max_speed / speed; }
        }
        (pos, vel, new_vitality, current_layer)
    }).collect();

    for i in 0..n {
        state.positions[i] = new_results[i].0.clone();
        state.velocities[i] = new_results[i].1.clone();
        state.vitality[i] = new_results[i].2;
        state.layers[i] = new_results[i].3;
        for k in 0..super::sparse_vec::DIM {
            state.positions[i][k] += state.velocities[i][k];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::universe::Universe;

    fn avg_sim(u: &Universe) -> f32 {
        let cells = u.get_cells();
        let mut total = 0.0f32;
        let mut count = 0usize;
        for i in 0..cells.len() {
            for j in i+1..cells.len() {
                total += cells[i].claim.vec.cosine(&cells[j].claim.vec);
                count += 1;
            }
        }
        if count == 0 { 0.0 } else { total / count as f32 }
    }

    #[test]
    fn test_boid_cohesion_same_region() {
        let mut u = Universe::new();
        u.store("The cat is on the mat", "test", "test", 1.0);
        u.store("A cat sits on a mat",   "test", "test", 1.0);
        u.store("Cat on mat",            "test", "test", 1.0);
        u.store("Kitty on the mat",      "test", "test", 1.0);
        u.store("There is a cat on mat", "test", "test", 1.0);

        let before = avg_sim(&u);
        println!("Before flocking: {:.4}", before);

        let mut state = BoidState::from_universe(&u);
        let settings = BoidSettings::default();
        let field = crate::core::FieldState::default();
        for _ in 0..3 { run_boid_iteration(&mut state, &settings, &field); }
        state.apply_to_universe(&mut u);

        let after = avg_sim(&u);
        println!("After flocking:  {:.4}", after);
        assert!(after > before, "Cohesion should increase similarity: {} -> {}", before, after);
    }

    #[test]
    fn test_anchor_cells_do_not_move() {
        let mut u = Universe::new();
        u.store("E equals mc squared mass energy", "established-physics", "seed", 5.0); // anchor
        u.store("A cat sits on a mat", "established-physics", "seed", 1.0);

        let anchor_vec_before: Vec<i8> = u.get_cells()[0].claim.vec.data.clone();

        let mut state = BoidState::from_universe(&u);
        let settings = BoidSettings::default();
        let field = crate::core::FieldState::default();
        for _ in 0..5 { run_boid_iteration(&mut state, &settings, &field); }
        state.apply_to_universe(&mut u);

        let anchor_vec_after = &u.get_cells()[0].claim.vec.data;
        assert_eq!(&anchor_vec_before, anchor_vec_after, "Anchor cell must not be mutated by flocking");
        println!("Anchor protection: PASSED — anchor cell unchanged after 5 iterations");
    }

    #[test]
    fn test_cross_region_isolation() {
        let mut u = Universe::new();
        // Same topic, different regions — should NOT influence each other
        u.store("The cat is on the mat", "identity",  "test", 1.0);
        u.store("The cat is on the mat", "reasoning",  "test", 1.0);

        let sim_before = u.get_cells()[0].claim.vec.cosine(&u.get_cells()[1].claim.vec);

        let mut state = BoidState::from_universe(&u);
        let settings = BoidSettings::default();
        let field = crate::core::FieldState::default();
        for _ in 0..5 { run_boid_iteration(&mut state, &settings, &field); }
        state.apply_to_universe(&mut u);

        let sim_after = u.get_cells()[0].claim.vec.cosine(&u.get_cells()[1].claim.vec);
        // Similarity should not have increased due to cross-region pull
        println!("Cross-region sim before: {:.4}, after: {:.4}", sim_before, sim_after);
        assert!((sim_after - sim_before).abs() < 0.1,
            "Cross-region cells should not be pulled together: {} -> {}", sim_before, sim_after);
    }

    #[test]
    fn test_near_duplicate_flagging() {
        let mut u = Universe::new();
        // Near-identical sentences — should be flagged for merge, not pulled closer
        u.store("The cat is on the mat", "test", "test", 1.0);
        u.store("The cat is on the mat", "test", "test", 1.0); // exact duplicate

        let state = BoidState::from_universe(&u);
        let dupes = find_near_duplicates(&state);
        assert!(!dupes.is_empty(), "Near-duplicate pair should be detected");
        println!("Near-duplicate flagged: ({}, {}) sim={:.4}", dupes[0].0, dupes[0].1, dupes[0].2);
    }
}
