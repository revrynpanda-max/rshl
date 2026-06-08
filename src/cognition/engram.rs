use crate::core::{SparseVec, Universe, Cell};
use crate::core::claim::Claim;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

// ── Engram-Inspired Sparse Memory Allocation ─────────────────────────────────
//
// Biological basis from the transcripts:
//   - Engrams are sparse: only 2-6% of neurons per memory region
//   - Allocation is competitive: most excitable cells win
//   - Temporal linking: memories within ~6 hours share overlapping populations
//   - Energy landscape: memories are local minima in a potential energy surface
//
// This replaces KAI's dense experience storage with biologically-plausible
// sparse distributed memory.

/// Target sparsity: what fraction of the lattice should be recruited per memory
/// The transcript says 2-6% for biological engrams. We use 5% as a default.
pub const ENGRAM_SPARSITY: f32 = 0.05;

/// Temporal linking window: seconds within which memories share cells
/// The transcript says ~6 hours for biological linking. We use 1 hour for KAI.
pub const TEMPORAL_LINK_WINDOW_SECS: u64 = 3600;

/// Excitability decay rate: how fast cell excitability returns to baseline
/// After being recruited, a cell's excitability drops and recovers over time.
pub const EXCITABILITY_DECAY: f32 = 0.95;

/// Baseline excitability for all cells
pub const BASELINE_EXCITABILITY: f32 = 0.1;

/// Maximum excitability boost after being recruited
pub const EXCITABILITY_BOOST: f32 = 0.8;

/// Minimum energy threshold for a stable memory (local minimum)
pub const ENERGY_STABILITY_THRESHOLD: f32 = -0.5;

/// A sparse memory trace (engram) — a small subset of cells that encode one memory
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Engram {
    pub cell_indices: Vec<usize>,
    pub timestamp: u64,
    pub label: String,
    pub vec: SparseVec,
    pub energy: f32,
}

/// Cell state tracking excitability and energy contribution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CellState {
    pub excitability: f32,
    pub last_recruited: u64,
    pub energy_contribution: f32,
}

impl Default for CellState {
    fn default() -> Self {
        Self {
            excitability: BASELINE_EXCITABILITY,
            last_recruited: 0,
            energy_contribution: 0.0,
        }
    }
}

/// Engram memory system — manages sparse allocation and temporal linking
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngramSystem {
    pub states: Vec<CellState>,
    pub engrams: Vec<Engram>,
    pub last_engram_time: u64,
}

impl EngramSystem {
    pub fn new(capacity: usize) -> Self {
        Self {
            states: vec![CellState::default(); capacity],
            engrams: Vec::new(),
            last_engram_time: 0,
        }
    }

    /// Resize to match universe growth
    pub fn resize(&mut self, new_capacity: usize) {
        if new_capacity > self.states.len() {
            self.states.resize(new_capacity, CellState::default());
        }
    }

    /// Current Unix timestamp in seconds
    fn now() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    }

    /// Update excitability: decay old values, boost recently recruited cells
    pub fn update_excitability(&mut self) {
        let now = Self::now();
        for state in &mut self.states {
            // Decay excitability over time
            let time_since_recruitment = now.saturating_sub(state.last_recruited);
            if time_since_recruitment > 0 {
                let decay_factor = EXCITABILITY_DECAY.powf(time_since_recruitment as f32);
                state.excitability = BASELINE_EXCITABILITY
                    + (state.excitability - BASELINE_EXCITABILITY) * decay_factor;
            }
        }
    }

    /// Allocate a sparse engram for a new memory
    ///
    /// Biological principle: only 2-6% of cells are recruited per memory.
    /// Competitive allocation: cells with highest excitability win.
    /// Temporal linking: if close in time to previous engram, force some overlap.
    pub fn allocate_engram(
        &mut self,
        universe: &mut Universe,
        label: &str,
        vec: &SparseVec,
    ) -> Engram {
        self.update_excitability();
        let now = Self::now();
        
        let cell_count = universe.get_cells().len();
        if cell_count == 0 {
            // No cells yet — store as a claim and return empty engram
            let mut claim = Claim::new(label, "engram", 2.0, vec.clone());
            universe.store_claim(claim, "engram");
            return Engram {
                cell_indices: vec![],
                timestamp: now,
                label: label.to_string(),
                vec: vec.clone(),
                energy: 0.0,
            };
        }

        // Ensure we have enough states
        self.resize(cell_count);

        // Target number of cells to recruit
        let target_count = ((cell_count as f32) * ENGRAM_SPARSITY).max(1.0).min(50.0) as usize;

        // Score all cells by: excitability + cosine similarity to input
        let mut scored: Vec<(usize, f32)> = (0..cell_count)
            .map(|i| {
                let cell = &universe.get_cells()[i];
                let sim = vec.cosine(&cell.claim.vec);
                let score = self.states[i].excitability + sim;
                (i, score)
            })
            .collect();

        // Sort by score descending (competitive selection)
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        // Check temporal linking: if close in time to previous engram, share some cells
        let mut selected = HashSet::new();
        let time_since_last = now.saturating_sub(self.last_engram_time);
        
        if time_since_last < TEMPORAL_LINK_WINDOW_SECS && !self.engrams.is_empty() {
            // Force overlap with the most recent engram (temporal linking)
            let last_engram = self.engrams.last().unwrap();
            let overlap_count = (target_count / 4).max(1); // 25% overlap
            for idx in last_engram.cell_indices.iter().take(overlap_count) {
                if *idx < cell_count {
                    selected.insert(*idx);
                }
            }
        }

        // Fill remaining slots from top-scored candidates
        for (idx, _) in scored {
            if selected.len() >= target_count {
                break;
            }
            selected.insert(idx);
        }

        let selected_vec: Vec<usize> = selected.into_iter().collect();

        // Update excitability for recruited cells
        for idx in &selected_vec {
            self.states[*idx].excitability = (self.states[*idx].excitability + EXCITABILITY_BOOST).min(1.0);
            self.states[*idx].last_recruited = now;
        }

        // Calculate energy of this engram
        let energy = self.calculate_engram_energy(universe, &selected_vec, vec);

        // Store the engram
        let engram = Engram {
            cell_indices: selected_vec,
            timestamp: now,
            label: label.to_string(),
            vec: vec.clone(),
            energy,
        };
        
        self.engrams.push(engram.clone());
        self.last_engram_time = now;

        // Also store a claim for the engram so it can be queried
        let engram_label = format!("[ENGRAM] {}", label);
        let mut claim = Claim::new(&engram_label, "engram", 2.5, vec.clone());
        claim.layer = crate::core::claim::LAYER_EXPERIENTIAL;
        universe.store_claim(claim, "engram");

        engram
    }

    /// Calculate energy of an engram: lower energy = more stable memory
    ///
    /// Energy = -sum(cosine similarity between engram vector and each cell vector)
    ///          - sum(connection weights between selected cells)
    ///
    /// This is analogous to the Hopfield energy function.
    pub fn calculate_engram_energy(
        &self,
        universe: &Universe,
        cell_indices: &[usize],
        vec: &SparseVec,
    ) -> f32 {
        let cells = universe.get_cells();
        let mut energy = 0.0f32;

        // Field energy: how well the engram vector aligns with selected cells
        for idx in cell_indices {
            if let Some(cell) = cells.get(*idx) {
                let sim = vec.cosine(&cell.claim.vec);
                energy -= sim; // Lower energy when aligned
            }
        }

        // Connection energy: penalize if selected cells don't reinforce each other
        // (This is a simplified version of the Hopfield energy term)
        for i in 0..cell_indices.len() {
            for j in (i + 1)..cell_indices.len() {
                let idx_i = cell_indices[i];
                let idx_j = cell_indices[j];
                if let (Some(cell_i), Some(cell_j)) = (cells.get(idx_i), cells.get(idx_j)) {
                    let connection = cell_i.claim.vec.cosine(&cell_j.claim.vec);
                    energy -= connection * 0.5; // Lower energy when cells are connected
                }
            }
        }

        energy
    }

    /// Recall: given a partial cue, find the nearest engram (energy minimum)
    ///
    /// This is pattern completion: start from the cue, descend the energy landscape
    /// to find the closest stored memory.
    pub fn recall(&self, cue_vec: &SparseVec) -> Option<&Engram> {
        if self.engrams.is_empty() {
            return None;
        }

        let mut best_engram = None;
        let mut best_score = f32::NEG_INFINITY;

        for engram in &self.engrams {
            let sim = cue_vec.cosine(&engram.vec);
            // Score combines similarity and energy stability
            let score = sim + engram.energy.min(0.0) * 0.1;
            if score > best_score {
                best_score = score;
                best_engram = Some(engram);
            }
        }

        best_engram
    }

    /// Get the most recent engrams for temporal linking
    pub fn recent_engrams(&self, count: usize) -> Vec<&Engram> {
        self.engrams.iter().rev().take(count).collect()
    }

    /// Prune old engrams to prevent unbounded growth
    pub fn prune_old_engrams(&mut self, max_age_secs: u64) {
        let now = Self::now();
        self.engrams.retain(|e| now - e.timestamp < max_age_secs);
    }

    /// Count total cells allocated across all engrams
    pub fn total_allocated_cells(&self) -> usize {
        self.engrams.iter().map(|e| e.cell_indices.len()).sum()
    }

    /// Get average engram sparsity
    pub fn average_sparsity(&self, total_cells: usize) -> f32 {
        if self.engrams.is_empty() || total_cells == 0 {
            return 0.0;
        }
        let avg_size = self.engrams.iter().map(|e| e.cell_indices.len()).sum::<usize>() as f32
            / self.engrams.len() as f32;
        avg_size / total_cells as f32
    }
}

/// Convenience: store a sparse engram memory from an experience record
pub fn store_sparse_experience(
    engram_system: &mut EngramSystem,
    universe: &mut Universe,
    input_text: &str,
    input_vec: &SparseVec,
    emotion_label: &str,
    output_text: &str,
    output_vec: &SparseVec,
) -> Engram {
    // Build a combined vector representing the experience
    let slot_in = SparseVec::encode("slot_experience_input");
    let slot_em = SparseVec::encode("slot_experience_emotion");
    let slot_out = SparseVec::encode("slot_experience_output");

    let bound_in = input_vec.bind(&slot_in);
    let bound_em = SparseVec::encode(emotion_label).bind(&slot_em);
    let bound_out = output_vec.bind(&slot_out);

    let combined = SparseVec::superpose_sparse(&[&bound_in, &bound_em, &bound_out], 0.04);

    let label = format!(
        "User felt {} about '{}'. KAI responded: '{}'",
        emotion_label, input_text, output_text
    );

    engram_system.allocate_engram(universe, &label, &combined)
}

/// Retrieve memories that are linked to a given cue through temporal overlap
pub fn retrieve_linked_memories(
    engram_system: &EngramSystem,
    cue_vec: &SparseVec,
    min_similarity: f32,
) -> Vec<(String, f32)> {
    let mut results = Vec::new();

    for engram in &engram_system.engrams {
        let sim = cue_vec.cosine(&engram.vec);
        if sim >= min_similarity {
            results.push((engram.label.clone(), sim));
        }
    }

    // Sort by similarity descending
    results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    results
}

/// Pattern completion: given a degraded cue, reconstruct the full pattern
/// by iteratively descending the energy landscape
pub fn pattern_completion(
    engram_system: &EngramSystem,
    cue_vec: &SparseVec,
    iterations: usize,
) -> Option<SparseVec> {
    let mut current = cue_vec.clone();

    for _ in 0..iterations {
        if let Some(engram) = engram_system.recall(&current) {
            // Move toward the recalled engram (gradient descent on energy landscape)
            let alpha = 0.3; // Step size
            // Simple interpolation: current = current + alpha * (engram - current)
            // In VSA terms, we can superpose with the engram vector
            current = SparseVec::superpose_sparse(&[&current, &engram.vec], alpha);
            
            // If we're very close, we've converged
            if current.cosine(&engram.vec) > 0.95 {
                return Some(engram.vec.clone());
            }
        } else {
            break;
        }
    }

    Some(current)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::SparseVec;

    #[test]
    fn test_engram_allocation() {
        let mut universe = Universe::new();
        // Seed with some cells
        for i in 0..100 {
            let vec = SparseVec::encode(&format!("concept_{}", i));
            let mut claim = Claim::new(&format!("concept {}", i), "test", 1.0, vec);
            universe.store_claim(claim, "test");
        }

        let mut system = EngramSystem::new(100);
        let vec = SparseVec::encode("test memory");
        let engram = system.allocate_engram(&mut universe, "test memory", &vec);

        // Should be sparse (5% of 100 = 5 cells)
        assert!(engram.cell_indices.len() >= 1 && engram.cell_indices.len() <= 10,
            "Engram should be sparse, got {} cells", engram.cell_indices.len());
    }

    #[test]
    fn test_temporal_linking() {
        let mut universe = Universe::new();
        for i in 0..100 {
            let vec = SparseVec::encode(&format!("concept_{}", i));
            let mut claim = Claim::new(&format!("concept {}", i), "test", 1.0, vec);
            universe.store_claim(claim, "test");
        }

        let mut system = EngramSystem::new(100);
        
        let vec1 = SparseVec::encode("memory one");
        let engram1 = system.allocate_engram(&mut universe, "memory one", &vec1);
        
        let vec2 = SparseVec::encode("memory two");
        let engram2 = system.allocate_engram(&mut universe, "memory two", &vec2);

        // Should share some cells (temporal linking)
        let overlap: HashSet<usize> = engram1.cell_indices.iter().cloned().collect();
        let shared: Vec<&usize> = engram2.cell_indices.iter().filter(|idx| overlap.contains(idx)).collect();
        
        assert!(!shared.is_empty(), "Temporally close engrams should share cells");
    }

    #[test]
    fn test_pattern_completion() {
        let mut universe = Universe::new();
        for i in 0..100 {
            let vec = SparseVec::encode(&format!("concept_{}", i));
            let mut claim = Claim::new(&format!("concept {}", i), "test", 1.0, vec);
            universe.store_claim(claim, "test");
        }

        let mut system = EngramSystem::new(100);
        
        let vec = SparseVec::encode("complete me");
        let engram = system.allocate_engram(&mut universe, "complete me", &vec);

        // Create a degraded cue (similar but not identical)
        let cue = SparseVec::encode("complete");
        let completed = pattern_completion(&system, &cue, 10);
        
        assert!(completed.is_some(), "Pattern completion should return a result");
        let completed_vec = completed.unwrap();
        assert!(completed_vec.cosine(&vec) > 0.5, 
            "Completed pattern should be similar to original, got similarity {}", 
            completed_vec.cosine(&vec));
    }
}
