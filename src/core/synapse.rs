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
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::collections::hash_map::DefaultHasher;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

// -- Surprise-Gated Plasticity (opt-in) --
// KAI-native adaptation of the Titans "test-time memory via surprise" idea.
// When enabled (env KAI_SURPRISE_GATED=1), synaptic imprint strength is modulated
// by the CURRENT surprise signal -- KAI's EXISTING prediction error
// (PredictiveEngine::avg_error, an EMA in [0,1]). Surprising co-firings imprint
// harder (up to 2.5x); known/zero-surprise events imprint exactly as before (1.0x).
// Forgetting is also mildly accelerated for low-surprise, rarely-used synapses.
// OFF BY DEFAULT -- the engine is unchanged unless the flag is set.
pub static SURPRISE_GATED: AtomicBool = AtomicBool::new(false);

// ── Constants ─────────────────────────────────────────────────────────────────

/// Maximum synaptic weight — analogous to biological saturation
const MAX_WEIGHT: f32 = 1.0;

/// Minimum weight before the synapse is pruned (equivalent to synaptic elimination)
const MIN_WEIGHT: f32 = 0.01;

/// Base LTP gain per co-firing event
const BASE_LTP: f32 = 0.035;

/// Base LTD loss per idle sweep tick
const BASE_LTD: f32 = 0.0002;

/// Ticks of inactivity before LTD begins on a synapse
const LTD_IDLE_TICKS: u64 = 2500;

/// Maximum outgoing synapses per neuron (axon fan-out limit)
pub fn dynamic_fan_out(lattice_size: usize) -> usize {
    let f = (0.075 * lattice_size as f32).powf(1.0 / 3.0).ceil();
    (f as usize).max(8)
}

/// Maximum total synapses — 10M cap for dense associative memory on 400K+ cell lattices
const MAX_TOTAL_SYNAPSES: usize = 10_000_000;

// ── Synapse ───────────────────────────────────────────────────────────────────

/// A directional learned connection between two cells.
///
/// Directional because in biology synapses are one-way.
/// In practice we store both A→B and B→A when two cells co-fire,
/// which gives us bidirectional associative recall.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Synapse {
    /// Label of the firing (pre-synaptic) cell (Arc<str> dedupes across synapses)
    pub pre_label: Arc<str>,
    /// Label of the co-activated (post-synaptic) cell (Arc<str> dedupes across synapses)
    pub post_label: Arc<str>,
    /// Synaptic strength [0.0 – 1.0]. Grows via LTP, shrinks via LTD.
    pub weight: f32,
    /// Last tick this synapse fired (for LTD idle tracking)
    pub last_fire_tick: u64,
    /// Total times this synapse has fired (for audit/debug)
    pub fire_count: u64,
}

/// What one LTD sweep did (or, in dry-run mode, would have done).
///
/// Returned rather than logged so the caller decides what to surface. The old
/// `ltd_sweep()` returned `()`, which is part of why nobody noticed it had
/// never run: there was nothing to print and nothing to assert on.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct LtdReport {
    /// Synapses examined this pass.
    pub examined: usize,
    /// Synapses past the idle threshold that lost weight.
    pub weakened: usize,
    /// Synapses that fell below MIN_WEIGHT and were removed.
    pub pruned: usize,
    /// This pass performed the one-time post-load idle-clock rebase and
    /// deliberately skipped decay. See `ltd_sweep_inner`.
    pub rebased: bool,
    /// Nothing was mutated.
    pub dry_run: bool,
}

impl LtdReport {
    pub fn summary(&self) -> String {
        if self.rebased {
            return format!(
                "rebased idle clock for {} synapses (no decay this pass)",
                self.examined
            );
        }
        format!(
            "{}examined={} weakened={} pruned={}",
            if self.dry_run { "DRY-RUN " } else { "" },
            self.examined,
            self.weakened,
            self.pruned
        )
    }
}

// ── SynapticLayer ─────────────────────────────────────────────────────────────

/// Manages all explicit synaptic connections in the lattice.
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct SynapticLayer {
    pub synapses: Vec<Synapse>,
    /// pre_label → indices into self.synapses (fast fan-out lookup)
    #[serde(default)]
    pub index: HashMap<Arc<str>, Vec<usize>>,
    /// Latent Trace Map: Hashed essences of pruned synapses (Savings in Relearning)
    #[serde(default)]
    pub latent_traces: HashSet<u64>,
    /// Current tick counter
    pub tick: u64,
    /// Total LTP events applied
    pub total_ltp: u64,
    /// Total LTD events applied
    pub total_ltd: u64,
    /// Total synapses pruned
    pub total_pruned: u64,
    /// Current surprise level (0-1), mirror of the predictor's prediction error.
    /// Only consulted when SURPRISE_GATED is enabled. Set via set_surprise.
    #[serde(default)]
    pub surprise_level: f32,
    /// Runtime-only. Set by the persistence loader; never written to disk (the
    /// synapse blob uses a custom binary format and the metadata a separate
    /// `SynapticLayerV4` struct, so `serde(skip)` keeps both formats unchanged).
    ///
    /// Guards the one-time idle-clock rebase in `ltd_sweep`. See the comment
    /// there — without it, turning LTD on for the first time would treat the
    /// ENTIRE persisted graph as simultaneously idle.
    #[serde(skip)]
    pub loaded_from_disk: bool,
}

impl SynapticLayer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Set the current surprise level (clamped to [0,1]). Mirror of the
    /// predictor's prediction error. Used only when SURPRISE_GATED is on.
    pub fn set_surprise(&mut self, s: f32) {
        self.surprise_level = s.clamp(0.0, 1.0);
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
        lattice_size: usize,
    ) {
        // v9.10.565 — THE LTD BUG. This was `self.tick = tick`, a plain
        // assignment, and every one of the four production call sites passes
        // `0` (oracle_server.rs:1373, 4375, 5126, 6099). So each co-firing
        // RESET the layer's clock to zero, wiping whatever `ltd_sweep` had
        // accumulated — `ltd_sweep` does increment (`self.tick += 1`), it just
        // never got to keep the result. With the clock pinned at 0,
        // `idle = tick - last_fire_tick` was always 0, never exceeded
        // `LTD_IDLE_TICKS`, and LTD could not fire even once. The live brain
        // shows exactly that: total_ltp 110,824,577 / total_ltd 0 /
        // total_pruned 0, with max last_fire_tick across 6,996,506 synapses = 211.
        //
        // Monotonic now: a caller with a real tick can advance the clock, a
        // caller passing 0 can no longer rewind it.
        self.tick = self.tick.max(tick);
        let now = self.tick;
        if labels.len() < 2 { return; }

        // Contradiction suppresses bonding — contradicting cells shouldn't wire together
        let chi_gate = (1.0 - chi * 0.8).max(0.05);

        // LTP magnitude: base × dopamine boost × emergence boost × contradiction gate
        let mut ltp_gain = BASE_LTP
            * (1.0 + dopamine * 0.8)
            * (1.0 + phi_g * 0.5)
            * chi_gate;

        // Surprise-Gated Plasticity (opt-in): surprising co-firings imprint harder.
        // surprise=1.0 -> 2.5x imprint; surprise=0.0 -> 1.0x (unchanged from baseline).
        if SURPRISE_GATED.load(Ordering::Relaxed) {
            let surprise_mult = 1.0 + 1.5 * self.surprise_level;
            ltp_gain *= surprise_mult;
        }

        // Apply to all pairs (bidirectional)
        for i in 0..labels.len() {
            for j in 0..labels.len() {
                if i == j { continue; }
                // Stamp with the layer's own monotonic clock, not the caller's
                // argument — otherwise `last_fire_tick` is set to 0 by the four
                // call sites that pass 0, and a synapse that just fired looks
                // maximally stale the moment the clock does start moving.
                self.apply_ltp(&labels[i], &labels[j], ltp_gain, now, lattice_size);
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
            if let Some(indices) = self.index.get(label.as_str()) {
                for &idx in indices {
                    let syn = &self.synapses[idx];
                    // Don't boost cells that already fired
                    if fired_labels.iter().any(|l| l.as_str() == &*syn.post_label) { continue; }
                    let entry = boosts.entry(syn.post_label.to_string()).or_insert(0.0);
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
    pub fn ltd_sweep(&mut self) -> LtdReport {
        self.ltd_sweep_inner(false)
    }

    /// Identical analysis, mutates nothing. Run this first on a large brain: it
    /// reports exactly what a live sweep would weaken and prune, so turning a
    /// garbage collector loose on millions of edges is an informed decision
    /// rather than a hopeful one.
    pub fn ltd_sweep_dry(&mut self) -> LtdReport {
        self.ltd_sweep_inner(true)
    }

    fn ltd_sweep_inner(&mut self, dry_run: bool) -> LtdReport {
        self.tick += 1;
        let tick = self.tick;
        let examined = self.synapses.len();

        // ── One-time idle-clock rebase after loading from disk ───────────────
        //
        // This guard is why turning LTD on does not detonate the graph. Because
        // the clock was pinned at 0 for the whole life of this brain, all
        // ~7M persisted synapses carry `last_fire_tick` in the range 0..=211.
        // The instant the clock passes LTD_IDLE_TICKS, EVERY synapse — the ones
        // firing constantly and the ones untouched for months alike — becomes
        // "idle" simultaneously and decays at the same rate. That erases the
        // recent-vs-stale distinction that LTD exists to draw, which is the
        // opposite of the intended effect.
        //
        // The same reasoning covers a long shutdown: idleness should measure
        // "not used while running", never wall-clock absence. So if the stamps
        // are further behind the clock than the idle threshold, they carry no
        // usable information — reset them and start the clock fairly from now.
        if self.loaded_from_disk {
            let max_lft = self.synapses.iter().map(|s| s.last_fire_tick).max().unwrap_or(0);
            if tick.saturating_sub(max_lft) > LTD_IDLE_TICKS {
                if dry_run {
                    // Report the rebase without performing it, and leave the
                    // flag armed so the first LIVE sweep still does it. A dry
                    // run that silently consumed the one-shot rebase would let
                    // the real sweep proceed straight to decaying everything.
                    self.tick = self.tick.saturating_sub(1);
                } else {
                    self.loaded_from_disk = false;
                    for syn in self.synapses.iter_mut() {
                        syn.last_fire_tick = tick;
                    }
                }
                return LtdReport {
                    examined,
                    weakened: 0,
                    pruned: 0,
                    rebased: true,
                    dry_run,
                };
            }
            // Stamps are usable; consume the one-shot regardless.
            self.loaded_from_disk = false;
        }

        // Surprise-Gated forgetting (opt-in): low-surprise, rarely-reinforced
        // associations decay a touch faster. Conservative and only active when on.
        let surprise_gated = SURPRISE_GATED.load(Ordering::Relaxed);
        let surprise_level = self.surprise_level;

        let mut to_prune: Vec<usize> = Vec::new();
        let mut weakened = 0usize;

        for (idx, syn) in self.synapses.iter_mut().enumerate() {
            let idle = tick.saturating_sub(syn.last_fire_tick);
            if idle > LTD_IDLE_TICKS {
                let idle_factor = ((idle - LTD_IDLE_TICKS) as f32 / 200.0).min(3.0);
                let mut loss = BASE_LTD * (1.0 + idle_factor);
                if surprise_gated && syn.fire_count <= 2 && surprise_level < 0.25 {
                    loss *= 1.5;
                }
                let new_weight = (syn.weight - loss).max(0.0);
                weakened += 1;
                if !dry_run {
                    syn.weight = new_weight;
                    self.total_ltd += 1;
                }
                if new_weight < MIN_WEIGHT {
                    to_prune.push(idx);
                }
            }
        }

        if dry_run {
            // Undo the clock advance so a dry run is fully side-effect free.
            self.tick = self.tick.saturating_sub(1);
            return LtdReport {
                examined,
                weakened,
                pruned: to_prune.len(),
                rebased: false,
                dry_run: true,
            };
        }
        let pruned_count = to_prune.len();

        // Prune weakest synapses (reverse order to preserve indices)
        for idx in to_prune.into_iter().rev() {
            let syn = self.synapses.remove(idx);
            
            // Generate latent trace before deleting.
            // BOUND (RAM leak guard): latent_traces otherwise grows forever — one hash
            // per pruned synapse, never evicted. Over long uptime that's an unbounded
            // HashSet. Cap it at a generous ceiling: once full we stop adding NEW traces
            // (we never clear existing ones, so all currently-tracked LTD memory is
            // preserved — only growth is bounded). At ~16 bytes/entry this caps the set
            // near ~32 MB instead of climbing without limit.
            const LATENT_TRACES_CAP: usize = 2_000_000;
            let mut hasher = DefaultHasher::new();
            syn.pre_label.hash(&mut hasher);
            syn.post_label.hash(&mut hasher);
            if self.latent_traces.len() < LATENT_TRACES_CAP {
                self.latent_traces.insert(hasher.finish());
            }

            // Remove from index
            if let Some(indices) = self.index.get_mut(&syn.pre_label) {
                indices.retain(|&i| i != idx);
            }
            self.total_pruned += 1;
        }

        // Rebuild index after pruning (indices shifted).
        // Only when something was actually removed — this walks every synapse
        // and on a 7M-edge graph it is the expensive part of the sweep. The
        // common case is "nothing crossed MIN_WEIGHT this pass", and paying for
        // a full rebuild then is what would make a periodic sweep unaffordable.
        if pruned_count > 0 {
            self.rebuild_index();
        }

        LtdReport {
            examined,
            weakened,
            pruned: pruned_count,
            rebased: false,
            dry_run: false,
        }
    }

    /// Returns the current synaptic weight between two labels, or 0.0 if no synapse.
    pub fn weight(&self, pre: &str, post: &str) -> f32 {
        if let Some(indices) = self.index.get(pre) {
            for &idx in indices {
                if &*self.synapses[idx].post_label == post {
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

    fn apply_ltp(&mut self, pre: &str, post: &str, gain: f32, tick: u64, lattice_size: usize) {
        // Find existing synapse
        if let Some(indices) = self.index.get(pre) {
            for &idx in indices {
                if &*self.synapses[idx].post_label == post {
                    let syn = &mut self.synapses[idx];
                    
                    // Hyper-Synapse logic: If fired > 50 times, allow weight up to 5.0
                    let max_w = if syn.fire_count > 50 { 5.0 } else { MAX_WEIGHT };
                    
                    syn.weight = (syn.weight + gain).min(max_w);
                    syn.last_fire_tick = tick;
                    syn.fire_count += 1;
                    self.total_ltp += 1;
                    return;
                }
            }
        }

        // Check fan-out limit
        let fan_out = self.index.get(pre).map(|v| v.len()).unwrap_or(0);
        if fan_out >= dynamic_fan_out(lattice_size) { return; }

        // Check total limit
        if self.synapses.len() >= MAX_TOTAL_SYNAPSES { return; }

        // Create new synapse
        let idx = self.synapses.len();
        let pre_arc: Arc<str> = pre.into();
        let post_arc: Arc<str> = post.into();
        
        // Check Latent Trace Map for the "Oh yeah, I remember!" multiplier
        let mut hasher = DefaultHasher::new();
        pre.hash(&mut hasher);
        post.hash(&mut hasher);
        let trace_hash = hasher.finish();
        
        let actual_gain = if self.latent_traces.contains(&trace_hash) {
            gain * 15.0 // Massive relearning multiplier
        } else {
            gain
        };

        self.synapses.push(Synapse {
            pre_label: pre_arc.clone(),
            post_label: post_arc,
            weight: actual_gain,
            last_fire_tick: tick,
            fire_count: 1,
        });
        self.index.entry(pre_arc).or_default().push(idx);
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
        // Hyper-Synapses can drive the score up to 5.0 (unignorable signal)
        (base_score + syn_boost * synapse_gate).min(5.0)
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
                    if cell.claim.layer == 2 && cell.claim.user_id.as_ref() != user_id {
                        continue;
                    }
                    if !regions.is_empty() && !regions.contains(&cell.region.as_ref()) {
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

    /// Multi-hop associative retrieval — follow synaptic chains 3–5 steps deep.
    ///
    /// This is the core reasoning mechanism. Single-hop associative recall
    /// finds direct neighbors; multi-hop traces indirect connections:
    ///   "cat" → "mat" → "floor" → "carpet" → "vacuum"
    ///
    /// Each hop decays the signal by `decay` (default 0.7) so distant
    /// associations contribute less. The result is a richer context set
    /// that captures latent relational structure invisible to cosine alone.
    ///
    /// Returns all unique hits merged from every hop, ranked by cumulative
    /// effective score.
    pub fn query_multi_hop(
        universe: &crate::core::Universe,
        synaptic_layer: &SynapticLayer,
        phi_g: f32,
        text: &str,
        n: usize,
        regions: &[&str],
        user_id: &str,
        max_hops: usize,
    ) -> Vec<crate::core::QueryHit> {
        let max_hops = max_hops.max(1).min(5);
        let decay = 0.7f32;

        // ── Hop 0: geometric retrieval ────────────────────────────────────
        let mut all_hits: Vec<crate::core::QueryHit> =
            universe.query_in_regions(text, n * 2, regions, user_id);
        let mut visited: std::collections::HashSet<String> =
            all_hits.iter().map(|h| h.label.clone()).collect();

        // ── Hops 1..N: synaptic propagation ───────────────────────────────
        let mut frontier: Vec<String> = all_hits.iter().map(|h| h.label.clone()).collect();

        for hop in 1..=max_hops {
            if frontier.is_empty() { break; }

            // Propagate one step from current frontier
            let synaptic_boosts = synaptic_layer.propagate(&frontier);

            // Build next frontier from newly discovered cells
            let mut next_frontier: Vec<String> = Vec::new();
            let hop_decay = decay.powi(hop as i32);

            for (label, boost) in synaptic_boosts {
                if visited.contains(&label) { continue; }
                if boost * hop_decay < 0.05 { continue; } // too weak after decay

                if let Some(cell) = universe.get_cell_by_label(&label) {
                    // Isolation & region checks
                    if cell.claim.layer == 2 && cell.claim.user_id.as_ref() != user_id {
                        continue;
                    }
                    if !regions.is_empty() && !regions.contains(&cell.region.as_ref()) {
                        continue;
                    }

                    let effective = Self::effective_score(0.0, boost * hop_decay, phi_g);
                    let mut hit = crate::core::QueryHit::from_cell(cell, 0.0);
                    hit.score = effective;
                    all_hits.push(hit);

                    visited.insert(label.clone());
                    next_frontier.push(label);
                }
            }

            frontier = next_frontier;
        }

        // ── Merge & rank ────────────────────────────────────────────────
        // Deduplicate by label, keeping the highest score
        let mut best: std::collections::HashMap<String, crate::core::QueryHit> =
            std::collections::HashMap::new();
        for hit in all_hits {
            best.entry(hit.label.clone())
                .and_modify(|h| h.score = h.score.max(hit.score))
                .or_insert(hit);
        }

        let mut merged: Vec<crate::core::QueryHit> = best.into_values().collect();
        merged.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        merged.truncate(n + max_hops * 2);
        merged
    }

    /// Quad-Level Resonance: searches for mutually resonant "thought clusters" instead of isolated cells.
    /// Finds combinations of cells that share a high geometric and synaptic resonance
    /// (the 16,384-dimensional Quad-Level physics from the Sovereign Mind architecture).
    pub fn query_quad_level_resonance(
        universe: &crate::core::Universe,
        synaptic_layer: &SynapticLayer,
        phi_g: f32,
        text: &str,
        n: usize,
        regions: &[&str],
        user_id: &str,
    ) -> Vec<crate::core::QueryHit> {
        // Step 1: Broad geometric retrieval to get candidate pool
        let mut base_hits = Self::query_multi_hop(universe, synaptic_layer, phi_g, text, n * 3, regions, user_id, 3);
        
        if base_hits.len() < 4 {
            return base_hits; // Not enough cells to form a structural quad cluster
        }
        
        // Step 2: Compute Quad-Level structural integrity
        // We look for cells that have high synaptic/geometric resonance with each other.
        // A true "Quad" is a set of nodes heavily interconnected structurally.
        let mut interconnected_boost = std::collections::HashMap::new();
        
        for i in 0..base_hits.len() {
            for j in 0..base_hits.len() {
                if i == j { continue; }
                let weight = synaptic_layer.weight(&base_hits[i].label, &base_hits[j].label);
                if weight > 0.1 {
                    // Mutual resonance detected in the sparse field
                    *interconnected_boost.entry(base_hits[i].label.clone()).or_insert(0.0_f32) += weight * 0.75;
                }
            }
        }
        
        // Apply quad-level resonance boosts
        for hit in base_hits.iter_mut() {
            if let Some(boost) = interconnected_boost.get(&hit.label) {
                // If this node is part of a strong structural cluster, it gets a massive structural boost
                hit.score = Self::effective_score(hit.score, *boost, phi_g);
            }
        }
        
        base_hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        base_hits.truncate(n);
        base_hits
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
        sl.record_co_firing(&labels, 0.5, 0.5, 0.2, 1, 400_000);
        assert!(!sl.synapses.is_empty(), "synapses should be created on co-firing");
        assert!(sl.weight("cat", "mat") > 0.0, "cat→mat synapse should exist");
        assert!(sl.weight("mat", "cat") > 0.0, "mat→cat synapse should exist (bidirectional)");
    }

    #[test]
    fn test_ltp_strengthens_repeated_co_firing() {
        let mut sl = SynapticLayer::new();
        let labels = make_labels(&["apple", "fruit"]);
        sl.record_co_firing(&labels, 0.5, 0.5, 0.2, 1, 400_000);
        let w1 = sl.weight("apple", "fruit");
        sl.record_co_firing(&labels, 0.5, 0.5, 0.2, 2, 400_000);
        let w2 = sl.weight("apple", "fruit");
        assert!(w2 > w1, "repeated co-firing should strengthen synapse: {:.4} → {:.4}", w1, w2);
    }

    #[test]
    fn test_high_dopamine_boosts_ltp() {
        let mut sl_low = SynapticLayer::new();
        let mut sl_high = SynapticLayer::new();
        let labels = make_labels(&["concept_a", "concept_b"]);
        sl_low.record_co_firing(&labels, 0.1, 0.5, 0.2, 1, 400_000);
        sl_high.record_co_firing(&labels, 0.9, 0.5, 0.2, 1, 400_000);
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
        sl_clear.record_co_firing(&labels, 0.5, 0.5, 0.05, 1, 400_000);   // low chi
        sl_conflict.record_co_firing(&labels, 0.5, 0.5, 0.95, 1, 400_000); // high chi
        let w_clear    = sl_clear.weight("claim_a", "claim_b");
        let w_conflict = sl_conflict.weight("claim_a", "claim_b");
        assert!(w_clear > w_conflict,
            "contradiction should suppress bonding: clear={:.4} conflict={:.4}", w_clear, w_conflict);
    }

    #[test]
    fn test_propagation_boosts_associated_cells() {
        let mut sl = SynapticLayer::new();
        // Wire "summer" → "heat" through co-firing
        sl.record_co_firing(&make_labels(&["summer", "heat"]), 0.8, 0.7, 0.1, 1, 400_000);
        sl.record_co_firing(&make_labels(&["summer", "heat"]), 0.8, 0.7, 0.1, 2, 400_000);
        sl.record_co_firing(&make_labels(&["summer", "heat"]), 0.8, 0.7, 0.1, 3, 400_000);

        // Now only "summer" fires — does "heat" get a boost?
        let boosts = sl.propagate(&make_labels(&["summer"]));
        let heat_boost = boosts.iter().find(|(label, _)| label == "heat");
        assert!(heat_boost.is_some(), "heat should be activated by summer's propagation");
        assert!(heat_boost.unwrap().1 > 0.0, "heat boost should be positive");
    }

    #[test]
    fn test_ltd_weakens_idle_synapse() {
        let mut sl = SynapticLayer::new();
        sl.record_co_firing(&make_labels(&["old_a", "old_b"]), 0.5, 0.5, 0.2, 0, 400_000);
        let w_before = sl.weight("old_a", "old_b");

        // Advance tick past LTD threshold
        sl.tick = LTD_IDLE_TICKS + 50;
        sl.ltd_sweep();

        let w_after = sl.weight("old_a", "old_b");
        assert!(w_after < w_before,
            "idle synapse should weaken via LTD: {:.4} → {:.4}", w_before, w_after);
    }

    /// **The regression test for the actual bug.** Production passes `tick = 0`
    /// from all four `record_co_firing` call sites. The old code did
    /// `self.tick = tick`, so every co-firing reset the clock to zero and LTD
    /// could never fire — 110,824,577 LTP events on the live brain against
    /// 0 LTD, 0 pruned. The clock must be monotonic: a caller may advance it,
    /// never rewind it.
    #[test]
    fn co_firing_cannot_rewind_the_clock() {
        let mut sl = SynapticLayer::new();
        sl.tick = 5_000;
        // Exactly what production does — tick argument hardcoded to 0.
        sl.record_co_firing(&make_labels(&["a", "b"]), 0.5, 0.5, 0.2, 0, 400_000);
        assert_eq!(sl.tick, 5_000, "a tick=0 caller must not rewind the clock");

        sl.record_co_firing(&make_labels(&["c", "d"]), 0.5, 0.5, 0.2, 9_000, 400_000);
        assert_eq!(sl.tick, 9_000, "a real tick should still advance the clock");
    }

    /// A synapse that just fired must be stamped with the layer's real clock,
    /// not the caller's `0` — otherwise it looks maximally stale the instant
    /// the clock starts moving, and LTD eats the freshest edges first.
    #[test]
    fn fresh_synapse_is_not_immediately_idle() {
        let mut sl = SynapticLayer::new();
        sl.tick = 10_000;
        sl.record_co_firing(&make_labels(&["hot_a", "hot_b"]), 0.5, 0.5, 0.2, 0, 400_000);
        let w_before = sl.weight("hot_a", "hot_b");
        let report = sl.ltd_sweep();
        assert_eq!(report.weakened, 0, "a just-fired synapse must not be swept");
        assert!(
            (sl.weight("hot_a", "hot_b") - w_before).abs() < 1e-6,
            "fresh synapse lost weight"
        );
    }

    /// The migration guard. Every synapse on the live brain carries a
    /// `last_fire_tick` written while the clock was pinned at 0, so the first
    /// sweep after the fix would otherwise find the ENTIRE graph idle at once
    /// and decay everything uniformly — destroying the recent-vs-stale
    /// distinction LTD exists to draw.
    #[test]
    fn first_sweep_after_load_rebases_instead_of_decaying() {
        let mut sl = SynapticLayer::new();
        sl.record_co_firing(&make_labels(&["legacy_a", "legacy_b"]), 0.5, 0.5, 0.2, 0, 400_000);
        let w_before = sl.weight("legacy_a", "legacy_b");

        // Simulate the persisted state: stamps at ~0, clock far ahead.
        sl.tick = LTD_IDLE_TICKS * 4;
        sl.loaded_from_disk = true;

        let report = sl.ltd_sweep();
        assert!(report.rebased, "first post-load sweep should rebase: {}", report.summary());
        assert_eq!(report.weakened, 0, "rebase pass must not decay");
        assert!(
            (sl.weight("legacy_a", "legacy_b") - w_before).abs() < 1e-6,
            "rebase pass changed a weight"
        );

        // Rebase happens once; genuine idleness after it still decays.
        sl.tick += LTD_IDLE_TICKS * 2;
        let report2 = sl.ltd_sweep();
        assert!(!report2.rebased, "rebase must be one-shot");
        assert!(report2.weakened > 0, "real idleness should still decay: {}", report2.summary());
    }

    /// A dry run must report the same analysis while touching nothing — this is
    /// what makes it safe to point a garbage collector at 7M live edges.
    #[test]
    fn dry_run_reports_without_mutating() {
        let mut sl = SynapticLayer::new();
        sl.record_co_firing(&make_labels(&["x", "y"]), 0.5, 0.5, 0.2, 0, 400_000);
        sl.tick = LTD_IDLE_TICKS + 50;

        let w_before = sl.weight("x", "y");
        let tick_before = sl.tick;
        let ltd_before = sl.total_ltd;

        let dry = sl.ltd_sweep_dry();
        assert!(dry.dry_run);
        assert!(dry.weakened > 0, "dry run should still SEE the idle synapse");
        assert_eq!(sl.weight("x", "y"), w_before, "dry run mutated a weight");
        assert_eq!(sl.tick, tick_before, "dry run advanced the clock");
        assert_eq!(sl.total_ltd, ltd_before, "dry run bumped the counter");

        // And the live sweep then actually does it.
        let live = sl.ltd_sweep();
        assert_eq!(live.weakened, dry.weakened, "dry run should predict the live result");
        assert!(sl.weight("x", "y") < w_before);
    }

    #[test]
    fn test_fan_out_limit_enforced() {
        let mut sl = SynapticLayer::new();
        let pre = "hub_neuron";
        let lattice_size = 400_000;
        let limit = dynamic_fan_out(lattice_size);
        for i in 0..(limit + 10) {
            let post = format!("target_{}", i);
            sl.record_co_firing(&[pre.to_string(), post], 0.5, 0.5, 0.2, i as u64, lattice_size);
        }
        let fan_out = sl.index.get(pre).map(|v| v.len()).unwrap_or(0);
        assert!(fan_out <= limit,
            "fan-out should be capped at {}: got {}", limit, fan_out);
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

    // -- Surprise-Gated Plasticity --
    // SURPRISE_GATED is a global flag, so all assertions live in ONE test that
    // sets it, exercises high/low/off cases, and restores it before exit.
    #[test]
    fn test_surprise_gated_plasticity() {
        let prev = SURPRISE_GATED.load(Ordering::Relaxed);

        // Case 1: flag ON -- high surprise imprints harder than zero surprise.
        SURPRISE_GATED.store(true, Ordering::Relaxed);

        let mut sl_high = SynapticLayer::new();
        sl_high.set_surprise(0.9);
        sl_high.record_co_firing(&make_labels(&["key", "valueA"]), 0.5, 0.5, 0.2, 1, 400_000);
        let gain_high = sl_high.weight("key", "valueA");

        let mut sl_zero = SynapticLayer::new();
        sl_zero.set_surprise(0.0);
        sl_zero.record_co_firing(&make_labels(&["key", "valueA"]), 0.5, 0.5, 0.2, 1, 400_000);
        let gain_zero = sl_zero.weight("key", "valueA");

        assert!(gain_high > gain_zero,
            "flag ON: high-surprise should exceed zero-surprise: high={:.4} zero={:.4}",
            gain_high, gain_zero);

        // Case 2: flag OFF -- surprise_level has NO effect.
        SURPRISE_GATED.store(false, Ordering::Relaxed);

        let mut sl_off_high = SynapticLayer::new();
        sl_off_high.set_surprise(0.9);
        sl_off_high.record_co_firing(&make_labels(&["key", "valueA"]), 0.5, 0.5, 0.2, 1, 400_000);
        let gain_off_high = sl_off_high.weight("key", "valueA");

        let mut sl_off_zero = SynapticLayer::new();
        sl_off_zero.set_surprise(0.0);
        sl_off_zero.record_co_firing(&make_labels(&["key", "valueA"]), 0.5, 0.5, 0.2, 1, 400_000);
        let gain_off_zero = sl_off_zero.weight("key", "valueA");

        assert!((gain_off_high - gain_off_zero).abs() < 1e-6,
            "flag OFF: surprise_level must not change imprint: {:.6} vs {:.6}",
            gain_off_high, gain_off_zero);
        assert!((gain_off_zero - gain_zero).abs() < 1e-6,
            "flag-ON zero-surprise should equal flag-OFF baseline: {:.6} vs {:.6}",
            gain_zero, gain_off_zero);

        SURPRISE_GATED.store(prev, Ordering::Relaxed);
    }

    // Spec-named test: a high-surprise novel association must imprint with a
    // larger final weight than a low-surprise one when the flag is ON.
    #[test]
    fn surprise_gating_boosts_novel_associations() {
        let prev = SURPRISE_GATED.load(Ordering::Relaxed);
        SURPRISE_GATED.store(true, Ordering::Relaxed);

        let mut sl = SynapticLayer::new();

        // Maximally surprising association.
        sl.set_surprise(1.0);
        sl.record_co_firing(&make_labels(&["novel_pre", "novel_post"]), 0.5, 0.5, 0.2, 1, 400_000);
        let w_high = sl.weight("novel_pre", "novel_post");

        // Known / zero-surprise association (distinct labels, same layer).
        sl.set_surprise(0.0);
        sl.record_co_firing(&make_labels(&["known_pre", "known_post"]), 0.5, 0.5, 0.2, 2, 400_000);
        let w_low = sl.weight("known_pre", "known_post");

        assert!(w_high > w_low,
            "high-surprise novel association should imprint stronger: high={:.4} low={:.4}",
            w_high, w_low);

        SURPRISE_GATED.store(prev, Ordering::Relaxed);
    }
}
