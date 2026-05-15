//! Synapse Layer — Explicit learned connections between KAI's memory cells.
//!
//! This is the missing link between the neuron layer (Claim/Cell) and the
//! plasticity layer (NeuroplasticityEngine). In biology:
//!
//!   Pre-synaptic neuron  = the cell that fired (retrieved by a query)
//!   Post-synaptic neuron = the cell that co-fired in the same window
//!   Synaptic weight      = the learned strength of that specific connection
//!   LTP                  = weight INCREASES when pre + post fire together
//!   LTD                  = weight DECREASES when the synapse goes unused
//!
//! Without explicit synapses:
//!   KAI only recalls cells by cosine similarity to the query vector.
//!   "Cat" and "mat" are always retrieved by how similar their vectors are.
//!   If KAI has learned that Ryan always talks about cats AND mats together,
//!   that associative knowledge lives nowhere — it's lost every query.
//!
//! With explicit synapses:
//!   When "cat" and "mat" co-fire repeatedly, their synapse weight grows.
//!   Next time "cat" fires, the SynapticLayer propagates activation to "mat"
//!   with a learned boost — even if "mat" wouldn't make the cosine top-N.
//!   This is ASSOCIATIVE RECALL: the memory system reconstructs context.
//!
//! Connection to field state:
//!   - High Φg (coherent emergence) → LTP runs stronger → more bonding
//!   - High χ (contradiction) → LTP is suppressed between conflicting cells
//!   - Dopamine (RPE) → scales the LTP rate (surprise = learn more)
//!
//! Connection to boid engine:
//!   - Boids organize cells by GEOMETRIC proximity (vector space)
//!   - Synapses connect cells by TEMPORAL proximity (fired together)
//!   - Together: geometry clusters similar concepts, synapses link co-occurring ones
//!
//! Architecture note on cell addressing:
//!   Cells don't have stable integer IDs (Vec position changes on insert).
//!   We key synapses by (pre_label, post_label) — the label is a stable
//!   text fingerprint derived from the claim text, equivalent to a neuron address.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Constants ─────────────────────────────────────────────────────────────────

/// Maximum synaptic weight — analogous to biological saturation
const MAX_WEIGHT: f32 = 1.0;

/// Minimum weight before the synapse is pruned (equivalent to synaptic elimination)
const MIN_WEIGHT: f32 = 0.01;

/// Base LTP gain per co-firing event
const BASE_LTP: f32 = 0.035;

/// Base LTD loss per idle sweep tick
const BASE_LTD: f32 = 0.003;

/// Ticks of inactivity before LTD begins on a synapse
const LTD_IDLE_TICKS: u64 = 80;

/// Maximum outgoing synapses per neuron (axon fan-out limit)
const MAX_FAN_OUT: usize = 32;

/// Maximum total synapses — prevents memory explosion
const MAX_TOTAL_SYNAPSES: usize = 8192;

// ── Synapse ───────────────────────────────────────────────────────────────────

/// A directional learned connection between two cells.
///
/// Directional because in biology synapses are one-way.
/// In practice we store both A→B and B→A when two cells co-fire,
/// which gives us bidirectional associative recall.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Synapse {
    /// Label of the firing (pre-synaptic) cell
    pub pre_label: String,
    /// Label of the co-activated (post-synaptic) cell
    pub post_label: String,
    /// Synaptic strength [0.0 – 1.0]. Grows via LTP, shrinks via LTD.
    pub weight: f32,
    /// Last tick this synapse fired (for LTD idle tracking)
    pub last_fire_tick: u64,
    /// Total times this synapse has fired (for audit/debug)
    pub fire_count: u64,
}

// ── SynapticLayer ─────────────────────────────────────────────────────────────

/// Manages all explicit synaptic connections in the lattice.
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct SynapticLayer {
    pub synapses: Vec<Synapse>,
    /// pre_label → indices into self.synapses (fast fan-out lookup)
    #[serde(default)]
    index: HashMap<String, Vec<usize>>,
    /// Current tick counter
    pub tick: u64,
    /// Total LTP events applied
    pub total_ltp: u64,
    /// Total LTD events applied
    pub total_ltd: u64,
    /// Total synapses pruned
    pub total_pruned: u64,
}

impl SynapticLayer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record that a set of cells co-fired in the same query window.
    ///
    /// For every pair in `labels`, applies LTP to the A→B and B→A synapses.
    /// `dopamine` (0–1) and `phi_g` (0–1) jointly scale the LTP gain.
    /// `chi` (0–1) suppresses LTP when field contradiction is high.
    pub fn record_co_firing(
        &mut self,
        labels: &[String],
        dopamine: f32,
        phi_g: f32,
        chi: f32,
        tick: u64,
    ) {
        self.tick = tick;
        if labels.len() < 2 { return; }

        // Contradiction suppresses bonding — contradicting cells shouldn't wire together
        let chi_gate = (1.0 - chi * 0.8).max(0.05);

        // LTP magnitude: base × dopamine boost × emergence boost × contradiction gate
        let ltp_gain = BASE_LTP
            * (1.0 + dopamine * 0.8)
            * (1.0 + phi_g * 0.5)
            * chi_gate;

        // Apply to all pairs (bidirectional)
        for i in 0..labels.len() {
            for j in 0..labels.len() {
                if i == j { continue; }
                self.apply_ltp(&labels[i], &labels[j], ltp_gain, tick);
            }
        }
    }

    /// Propagate activation from fired cells to their synaptic partners.
    ///
    /// Returns a list of (label, activation_boost) for cells that should
    /// receive an associative recall boost in the next query scoring.
    /// This is the mechanism that lets KAI reconstruct context from partial cues.
    pub fn propagate(&self, fired_labels: &[String]) -> Vec<(String, f32)> {
        let mut boosts: HashMap<String, f32> = HashMap::new();

        for label in fired_labels {
            if let Some(indices) = self.index.get(label) {
                for &idx in indices {
                    let syn = &self.synapses[idx];
                    // Don't boost cells that already fired
                    if fired_labels.contains(&syn.post_label) { continue; }
                    let entry = boosts.entry(syn.post_label.clone()).or_insert(0.0);
                    *entry = (*entry + syn.weight * 0.4).min(0.8); // cap boost at 0.8
                }
            }
        }

        let mut result: Vec<(String, f32)> = boosts.into_iter().collect();
        // Sort by boost strength — strongest associations first
        result.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        result
    }

    /// LTD sweep — weaken synapses that haven't fired recently.
    ///
    /// Call this on a slow tick (e.g., every 30 world ticks).
    /// Prunes synapses that fall below MIN_WEIGHT.
    pub fn ltd_sweep(&mut self) {
        self.tick += 1;
        let tick = self.tick;

        let mut to_prune: Vec<usize> = Vec::new();

        for (idx, syn) in self.synapses.iter_mut().enumerate() {
            let idle = tick.saturating_sub(syn.last_fire_tick);
            if idle > LTD_IDLE_TICKS {
                let idle_factor = ((idle - LTD_IDLE_TICKS) as f32 / 200.0).min(3.0);
                let loss = BASE_LTD * (1.0 + idle_factor);
                syn.weight = (syn.weight - loss).max(0.0);
                self.total_ltd += 1;
                if syn.weight < MIN_WEIGHT {
                    to_prune.push(idx);
                }
            }
        }

        // Prune weakest synapses (reverse order to preserve indices)
        for idx in to_prune.into_iter().rev() {
            let syn = self.synapses.remove(idx);
            // Remove from index
            if let Some(indices) = self.index.get_mut(&syn.pre_label) {
                indices.retain(|&i| i != idx);
            }
            self.total_pruned += 1;
        }

        // Rebuild index after pruning (indices shifted)
        self.rebuild_index();
    }

    /// Returns the current synaptic weight between two labels, or 0.0 if no synapse.
    pub fn weight(&self, pre: &str, post: &str) -> f32 {
        if let Some(indices) = self.index.get(pre) {
            for &idx in indices {
                if self.synapses[idx].post_label == post {
                    return self.synapses[idx].weight;
                }
            }
        }
        0.0
    }

    /// How many unique cell labels have outgoing synapses?
    pub fn neuron_count(&self) -> usize {
        self.index.len()
    }

    /// One-line status for TUI/spectate.
    pub fn status_line(&self) -> String {
        format!(
            "SYN: {} synapses | {} neurons | LTP={} LTD={} pruned={}",
            self.synapses.len(),
            self.neuron_count(),
            self.total_ltp,
            self.total_ltd,
            self.total_pruned
        )
    }

    /// Top-N strongest synapses originating from a given label.
    pub fn strongest_from(&self, label: &str, n: usize) -> Vec<&Synapse> {
        let mut result: Vec<&Synapse> = Vec::new();
        if let Some(indices) = self.index.get(label) {
            for &idx in indices {
                result.push(&self.synapses[idx]);
            }
        }
        result.sort_by(|a, b| b.weight.partial_cmp(&a.weight).unwrap_or(std::cmp::Ordering::Equal));
        result.truncate(n);
        result
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    fn apply_ltp(&mut self, pre: &str, post: &str, gain: f32, tick: u64) {
        // Find existing synapse
        if let Some(indices) = self.index.get(pre) {
            for &idx in indices {
                if self.synapses[idx].post_label == post {
                    let syn = &mut self.synapses[idx];
                    syn.weight = (syn.weight + gain).min(MAX_WEIGHT);
                    syn.last_fire_tick = tick;
                    syn.fire_count += 1;
                    self.total_ltp += 1;
                    return;
                }
            }
        }

        // Check fan-out limit
        let fan_out = self.index.get(pre).map(|v| v.len()).unwrap_or(0);
        if fan_out >= MAX_FAN_OUT { return; }

        // Check total limit
        if self.synapses.len() >= MAX_TOTAL_SYNAPSES { return; }

        // Create new synapse
        let idx = self.synapses.len();
        self.synapses.push(Synapse {
            pre_label: pre.to_string(),
            post_label: post.to_string(),
            weight: gain,
            last_fire_tick: tick,
            fire_count: 1,
        });
        self.index.entry(pre.to_string()).or_default().push(idx);
        self.total_ltp += 1;
    }

    fn rebuild_index(&mut self) {
        self.index.clear();
        for (idx, syn) in self.synapses.iter().enumerate() {
            self.index.entry(syn.pre_label.clone()).or_default().push(idx);
        }
    }
}

// ── Neural Bus — the signal chain ────────────────────────────────────────────

/// The ordered signal chain connecting all KAI brain modules.
///
/// This is the wiring diagram. Call each stage in this order every query:
///
///   1. EMBED         → text → sparse ternary vector
///   2. QUERY         → Universe cosine+keyword → top-N firing cells
///   3. PROPAGATE     → SynapticLayer boosts associated cells (associative recall)
///   4. FIELD UPDATE  → FieldState computes Φg, χ, R from fired cell set
///   5. DOPAMINE      → RPE = confidence delta → modulate LTP rate
///   6. LTP           → SynapticLayer.record_co_firing (strengthens bonds)
///   7. OSCILLATOR    → NeuralOscillator perturbs field (keeps brain live)
///   8. HIPPOCAMPUS   → Pattern completion (fills in missing context)
///   9. THEORY MIND   → Updates user knowledge model from what fired
///  10. BOID STEP     → BoidEngine reorganizes cell geometry in vector space
///  11. NEUROPLAST.   → Cell-level LTP/LTD (confidence up/down)
///  12. OUTPUT        → Return hits + context to caller
///
/// The key principle: every module reads from the field and writes back to it.
/// Φg is the shared signal — it rises when the system is coherent and falls
/// when it's contradictory. All modules use it as their health signal.
pub struct NeuralBus;

impl NeuralBus {
    /// Compute the effective firing score for a cell, incorporating synaptic boosts.
    ///
    /// base_score  = raw cosine+keyword score from Universe::query()
    /// syn_boost   = activation from SynapticLayer::propagate()
    /// Returns the final score used for ranking.
    pub fn effective_score(base_score: f32, syn_boost: f32, phi_g: f32) -> f32 {
        // Synaptic boost is gated by emergence — high phi_g = synapses matter more
        let synapse_gate = 0.3 + phi_g * 0.4;
        (base_score + syn_boost * synapse_gate).min(1.0)
    }

    /// Compute LTP gain for a synapse given current neuromodulator state.
    ///
    /// dopamine    = reward signal (0–1, high = learn more)
    /// phi_g       = emergence (0–1, high coherence = stronger bonding)
    /// chi         = contradiction (0–1, high = suppress LTP)
    /// novelty     = 1 - R_val (surprise boosts learning)
    pub fn ltp_gain(dopamine: f32, phi_g: f32, chi: f32, novelty: f32) -> f32 {
        BASE_LTP
            * (1.0 + dopamine * 0.8)
            * (1.0 + phi_g * 0.5)
            * (1.0 + novelty * 0.3)
            * (1.0 - chi * 0.8).max(0.05)
    }

    /// Perform a full associative query using a universe and synaptic layer.
    /// This is the decoupled version of Engine::query.
    pub fn query_associative(
        universe: &crate::core::Universe,
        synaptic_layer: &SynapticLayer,
        phi_g: f32,
        text: &str,
        n: usize,
        regions: &[&str],
        user_id: &str,
    ) -> Vec<crate::core::QueryHit> {
        // Stage 1: Geometric Retrieval (Isolated by user_id)
        let mut hits = universe.query_in_regions(text, n, regions, user_id);
        
        // Stage 2: Associative Recall
        let fired_labels: Vec<String> = hits.iter().map(|h| h.label.clone()).collect();
        let synaptic_boosts = synaptic_layer.propagate(&fired_labels);

        // Stage 3: Merge and Score
        for hit in hits.iter_mut() {
            if let Some((_, boost)) = synaptic_boosts.iter().find(|(lbl, _)| lbl == &hit.label) {
                hit.score = Self::effective_score(hit.score, *boost, phi_g);
            }
        }

        // B. Add associated cells (Associative Retrieval)
        for (label, boost) in synaptic_boosts {
            if !fired_labels.contains(&label) && boost > 0.15 {
                if let Some(cell) = universe.get_cell_by_label(&label) {
                    // Check isolation for associated cell too
                    if cell.claim.layer == 2 && cell.claim.user_id != user_id {
                        continue;
                    }
                    if !regions.is_empty() && !regions.contains(&cell.region.as_str()) {
                        continue;
                    }

                    let mut hit = crate::core::QueryHit::from_cell(cell, 0.0);
                    hit.score = Self::effective_score(0.0, boost, phi_g);
                    hits.push(hit);
                }
            }
        }

        hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        hits.truncate(n + 2);
        hits
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make_labels(words: &[&str]) -> Vec<String> {
        words.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn test_synapse_created_on_co_fire() {
        let mut sl = SynapticLayer::new();
        let labels = make_labels(&["cat", "mat", "floor"]);
        sl.record_co_firing(&labels, 0.5, 0.5, 0.2, 1);
        assert!(!sl.synapses.is_empty(), "synapses should be created on co-firing");
        assert!(sl.weight("cat", "mat") > 0.0, "cat→mat synapse should exist");
        assert!(sl.weight("mat", "cat") > 0.0, "mat→cat synapse should exist (bidirectional)");
    }

    #[test]
    fn test_ltp_strengthens_repeated_co_firing() {
        let mut sl = SynapticLayer::new();
        let labels = make_labels(&["apple", "fruit"]);
        sl.record_co_firing(&labels, 0.5, 0.5, 0.2, 1);
        let w1 = sl.weight("apple", "fruit");
        sl.record_co_firing(&labels, 0.5, 0.5, 0.2, 2);
        let w2 = sl.weight("apple", "fruit");
        assert!(w2 > w1, "repeated co-firing should strengthen synapse: {:.4} → {:.4}", w1, w2);
    }

    #[test]
    fn test_high_dopamine_boosts_ltp() {
        let mut sl_low = SynapticLayer::new();
        let mut sl_high = SynapticLayer::new();
        let labels = make_labels(&["concept_a", "concept_b"]);
        sl_low.record_co_firing(&labels, 0.1, 0.5, 0.2, 1);
        sl_high.record_co_firing(&labels, 0.9, 0.5, 0.2, 1);
        let w_low  = sl_low.weight("concept_a", "concept_b");
        let w_high = sl_high.weight("concept_a", "concept_b");
        assert!(w_high > w_low,
            "high dopamine should produce stronger synapse: low={:.4} high={:.4}", w_low, w_high);
    }

    #[test]
    fn test_contradiction_suppresses_ltp() {
        let mut sl_clear = SynapticLayer::new();
        let mut sl_conflict = SynapticLayer::new();
        let labels = make_labels(&["claim_a", "claim_b"]);
        sl_clear.record_co_firing(&labels, 0.5, 0.5, 0.05, 1);   // low chi
        sl_conflict.record_co_firing(&labels, 0.5, 0.5, 0.95, 1); // high chi
        let w_clear    = sl_clear.weight("claim_a", "claim_b");
        let w_conflict = sl_conflict.weight("claim_a", "claim_b");
        assert!(w_clear > w_conflict,
            "contradiction should suppress bonding: clear={:.4} conflict={:.4}", w_clear, w_conflict);
    }

    #[test]
    fn test_propagation_boosts_associated_cells() {
        let mut sl = SynapticLayer::new();
        // Wire "summer" → "heat" through co-firing
        sl.record_co_firing(&make_labels(&["summer", "heat"]), 0.8, 0.7, 0.1, 1);
        sl.record_co_firing(&make_labels(&["summer", "heat"]), 0.8, 0.7, 0.1, 2);
        sl.record_co_firing(&make_labels(&["summer", "heat"]), 0.8, 0.7, 0.1, 3);

        // Now only "summer" fires — does "heat" get a boost?
        let boosts = sl.propagate(&make_labels(&["summer"]));
        let heat_boost = boosts.iter().find(|(label, _)| label == "heat");
        assert!(heat_boost.is_some(), "heat should be activated by summer's propagation");
        assert!(heat_boost.unwrap().1 > 0.0, "heat boost should be positive");
    }

    #[test]
    fn test_ltd_weakens_idle_synapse() {
        let mut sl = SynapticLayer::new();
        sl.record_co_firing(&make_labels(&["old_a", "old_b"]), 0.5, 0.5, 0.2, 0);
        let w_before = sl.weight("old_a", "old_b");

        // Advance tick past LTD threshold
        sl.tick = LTD_IDLE_TICKS + 50;
        sl.ltd_sweep();

        let w_after = sl.weight("old_a", "old_b");
        assert!(w_after < w_before,
            "idle synapse should weaken via LTD: {:.4} → {:.4}", w_before, w_after);
    }

    #[test]
    fn test_fan_out_limit_enforced() {
        let mut sl = SynapticLayer::new();
        let pre = "hub_neuron";
        for i in 0..(MAX_FAN_OUT + 10) {
            let post = format!("target_{}", i);
            sl.record_co_firing(&[pre.to_string(), post], 0.5, 0.5, 0.2, i as u64);
        }
        let fan_out = sl.index.get(pre).map(|v| v.len()).unwrap_or(0);
        assert!(fan_out <= MAX_FAN_OUT,
            "fan-out should be capped at {}: got {}", MAX_FAN_OUT, fan_out);
    }

    #[test]
    fn test_effective_score_synaptic_boost() {
        let base  = 0.4_f32;
        let boost = 0.5_f32;
        let phi_g = 0.8_f32;
        let effective = NeuralBus::effective_score(base, boost, phi_g);
        assert!(effective > base,
            "synaptic boost should raise score: base={:.3} effective={:.3}", base, effective);
        assert!(effective <= 1.0, "score should be capped at 1.0: {:.3}", effective);
    }
}
