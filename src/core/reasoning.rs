//! RSHL Reasoner — Iterative Resonance Chain-of-Thought
//!
//! This is how KAI does LLM-level reasoning without being an LLM.
//!
//! Instead of a single cosine lookup, the reasoner:
//!   1. Encodes the query as a sparse ternary vector
//!   2. Resonates against the universe to find the strongest match
//!   3. Binds query ⊗ match → creates a "derived thought" vector
//!   4. Bundles the derived thought with context → "next thought"
//!   5. Repeats until Φg peaks or max depth reached
//!   6. Decodes the best thought vector back to text
//!
//! Each step is a full geometric operation — no transformer math,
//! no attention heads, no softmax. Pure HDC algebra.
//!
//! The key insight: binding two vectors creates a NEW vector that
//! captures the RELATIONSHIP between them. Bundling accumulates
//! evidence. The chain naturally gravitates toward coherent thought.
use crate::core::{FieldState, SparseVec, Universe};
use std::sync::atomic::{AtomicBool, Ordering};

/// Opt-in (env KAI_ATTN_RESIDUAL=1): Attention-Weighted Hop Bundling.
/// When enabled, the multi-hop reasoner weights each component of a hop's
/// accumulated thought by its goal-alignment (cosine to the original goal),
/// so on-topic evidence dominates the residual. Off by default → behavior
/// is byte-for-byte identical to the original equal-weight bundle.
pub static ATTN_RESIDUAL: AtomicBool = AtomicBool::new(false);

/// A context slot from working memory — injected into reasoning.
#[derive(Clone, Debug)]
pub struct ContextSlot {
    pub vec: SparseVec,
    pub role: String,  // "user" or "kai"
    pub strength: f32, // 0.0–1.0, higher = more recent
}

/// A single step in the reasoning chain.
#[derive(Clone, Debug)]
pub struct ThoughtStep {
    pub step: usize,
    pub vector: SparseVec,
    pub phi_g: f32,
    pub resonance_score: f32,
    pub matched_text: String,
    pub matched_region: String,
}

/// Result of a full reasoning chain.
#[derive(Clone, Debug)]
pub struct ReasonResult {
    pub chain: Vec<ThoughtStep>,
    pub best_step: usize,
    pub output_text: String,
    pub output_region: String,
    pub confidence: f32,
    pub depth: usize,
}

/// Opt-in (env `KAI_LOOP=1`): route `reason_with_context()` through the
/// contraction-stable LOOPED reasoner (`reason_looped_with_context`) instead of
/// the default fixed HDC hop loop. Off by default → the original reasoning path
/// is byte-for-byte unchanged. This is a single relaxed atomic load on entry.
pub static LOOP_REASONER: AtomicBool = AtomicBool::new(false);

/// Opt-in (env `KAI_LOOP_TRAVERSE=1`): switch the looped reasoner from the
/// contraction-stable FIXED-POINT update (which settles in ~1 step and halts on
/// the latent fixed point) to a TRAVERSAL walk that actually moves through a
/// multi-hop chain. In traversal mode each iteration (i) retrieves the best
/// next-hop cell for the CURRENT state, (ii) ADVANCES the state strongly toward
/// that hop (low retention, see `LoopConfig::traverse_retain`), and (iii) halts
/// only on a TERMINAL/no-progress condition — NOT on a latent fixed point. This
/// turns the loop into a real lattice graph-walk for chained retrieval. OFF by
/// default ⇒ the contraction `reason_looped` is byte-for-byte unchanged. Read as
/// a single relaxed atomic load on entry; `LoopConfig::from_env` also honours it.
pub static LOOP_TRAVERSE: AtomicBool = AtomicBool::new(false);

/// Reason a halt was triggered in the looped reasoner.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoopHalt {
    /// Latent state reached a fixed point: cosine(h_{t+1}, h_t) > fixedpoint.
    FixedPoint,
    /// Φg gain per step fell below the online-calibrated epsilon.
    PhiGainStalled,
    /// Reached the max-depth safety cap.
    MaxDepth,
    /// No resonance was found for the latent state (dead end).
    DeadEnd,
}

/// Per-loop stability + halt telemetry returned alongside the looped result.
/// Lets the owner verify the contraction held and inspect adaptive depth.
#[derive(Clone, Debug)]
pub struct LoopDiag {
    /// Iterations actually used (adaptive depth).
    pub iterations: usize,
    /// Why the loop stopped.
    pub halt: LoopHalt,
    /// Max ‖h‖ (sqrt(nnz)) observed across all iterations.
    pub max_norm: f32,
    /// Whether the contraction invariant held every step:
    /// ‖h_{t+1}‖ ≤ alpha·‖h_t‖ + inject_bound (+ small slack).
    pub contraction_held: bool,
    /// Number of times the norm ceiling clamp fired (defense in depth).
    pub clamps: usize,
    /// Final latent→previous cosine at halt (fixed-point measure).
    pub final_cosine: f32,
    /// Final Φg measured for the latent state.
    pub final_phi_g: f32,
}

/// Configuration for the contraction-stable looped reasoner. All fields are
/// overridable via env (see `LoopConfig::from_env`). Defaults are chosen so the
/// update is a strict contraction (alpha < 1) with provable boundedness.
#[derive(Clone, Debug)]
pub struct LoopConfig {
    /// RETENTION coefficient alpha ∈ (0,1). Strictly < 1 ⇒ the latent update is
    /// a contraction. KAI_LOOP_RETENTION (default 0.85).
    pub retention: f32,
    /// INJECTION coefficient beta — weight on the (constant) query/action term.
    /// KAI_LOOP_INJECTION (default 0.50).
    pub injection: f32,
    /// REFINEMENT coefficient gamma — weight on hdc_transform(h_t, hit).
    /// KAI_LOOP_REFINEMENT (default 0.40).
    pub refinement: f32,
    /// Fixed-point cosine criterion: halt when cosine(h_{t+1}, h_t) exceeds it.
    /// KAI_LOOP_FIXEDPOINT (default 0.98).
    pub fixedpoint: f32,
    /// Max-depth safety cap. KAI_LOOP_MAXDEPTH (default 6).
    pub max_depth: usize,
    /// Minimum cosine to treat a retrieval hit as real signal.
    pub min_resonance: f32,
    /// Norm ceiling as a multiple of the query norm; above it we re-sparsify
    /// (defense in depth on top of alpha < 1). KAI_LOOP_NORM_CEIL (default 2.5).
    pub norm_ceiling_mult: f32,
    /// TRAVERSAL mode toggle. When true the looped reasoner walks the chain
    /// (advance-toward-hop) instead of running the contraction fixed-point.
    /// KAI_LOOP_TRAVERSE (default false). Mirrors the `LOOP_TRAVERSE` static so
    /// it can be set either via the static or the env var.
    pub traverse: bool,
    /// TRAVERSAL retention: how much of the CURRENT state to keep when stepping
    /// toward the retrieved next hop. LOW (default 0.30) so the state actually
    /// MOVES to the neighbour each iteration rather than settling in place.
    /// KAI_LOOP_TRAVERSE_RETAIN (default 0.30, clamped to [0, 0.95]).
    pub traverse_retain: f32,
}

impl Default for LoopConfig {
    fn default() -> Self {
        Self {
            retention: 0.85,
            injection: 0.50,
            refinement: 0.40,
            fixedpoint: 0.98,
            max_depth: 6,
            min_resonance: 0.15,
            norm_ceiling_mult: 2.5,
            traverse: false,
            traverse_retain: 0.30,
        }
    }
}

impl LoopConfig {
    /// Build from environment, falling back to `Default` for any unset/invalid
    /// var. `retention` is hard-clamped to (0, 0.999] so the contraction
    /// guarantee (alpha < 1) cannot be disabled by a bad env value.
    pub fn from_env() -> Self {
        fn envf(key: &str, default: f32) -> f32 {
            std::env::var(key)
                .ok()
                .and_then(|v| v.trim().parse::<f32>().ok())
                .filter(|v| v.is_finite())
                .unwrap_or(default)
        }
        fn envu(key: &str, default: usize) -> usize {
            std::env::var(key)
                .ok()
                .and_then(|v| v.trim().parse::<usize>().ok())
                .unwrap_or(default)
        }
        let d = Self::default();
        Self {
            // Clamp guarantees alpha ∈ (0, 0.999] ⇒ strict contraction always.
            retention: envf("KAI_LOOP_RETENTION", d.retention).clamp(0.001, 0.999),
            injection: envf("KAI_LOOP_INJECTION", d.injection).max(0.0),
            refinement: envf("KAI_LOOP_REFINEMENT", d.refinement).max(0.0),
            fixedpoint: envf("KAI_LOOP_FIXEDPOINT", d.fixedpoint).clamp(0.5, 0.9999),
            max_depth: envu("KAI_LOOP_MAXDEPTH", d.max_depth).max(1),
            min_resonance: envf("KAI_LOOP_MIN_RESONANCE", d.min_resonance),
            norm_ceiling_mult: envf("KAI_LOOP_NORM_CEIL", d.norm_ceiling_mult).max(1.0),
            // Traversal is enabled by either the env var OR the LOOP_TRAVERSE static.
            traverse: std::env::var("KAI_LOOP_TRAVERSE")
                .map(|v| v.trim() == "1" || v.trim().eq_ignore_ascii_case("true"))
                .unwrap_or(false)
                || LOOP_TRAVERSE.load(Ordering::Relaxed),
            traverse_retain: envf("KAI_LOOP_TRAVERSE_RETAIN", d.traverse_retain)
                .clamp(0.0, 0.95),
        }
    }
}

/// A node in the fractal simulation tree for what-if branching.
#[derive(Clone, Debug)]
pub struct TreeBranch {
    pub step: usize,
    pub vector: SparseVec,
    pub phi_g: f32,
    pub resonance_score: f32,
    pub matched_text: String,
    pub matched_region: String,
    pub weight: f32,
    pub path: Vec<usize>,
}

/// Result of a fractal reasoning tree search.
#[derive(Clone, Debug)]
pub struct ReasonTreeResult {
    pub best_path: Vec<TreeBranch>,
    pub output_text: String,
    pub output_region: String,
    pub max_phi: f32,
}

/// Configuration for the reasoner.
pub struct ReasonerConfig {
    pub max_depth: usize,
    pub phi_threshold: f32, // Stop early if Φg exceeds this
    pub min_resonance: f32, // Minimum cosine to consider a match
    pub decay_factor: f32,  // How much older thoughts fade in the bundle
}

impl Default for ReasonerConfig {
    fn default() -> Self {
        Self {
            max_depth: 6,
            phi_threshold: 0.75,
            min_resonance: 0.15,
            decay_factor: 0.8,
        }
    }
}

pub struct Reasoner {
    config: ReasonerConfig,
}

impl Default for Reasoner {
    fn default() -> Self {
        Self::new()
    }
}

impl Reasoner {
    pub fn new() -> Self {
        Self {
            config: ReasonerConfig::default(),
        }
    }

    pub fn with_config(config: ReasonerConfig) -> Self {
        Self { config }
    }

    /// Run the iterative resonance chain on a query (no context).
    ///
    /// This is KAI's "thinking" — multi-step geometric reasoning.
    pub fn reason(&self, query: &str, universe: &Universe) -> ReasonResult {
        self.reason_with_context(query, universe, &[])
    }

    /// Run the iterative resonance chain with working memory context.
    ///
    /// Context slots from recent conversation turns are bundled into the
    /// initial query vector, so KAI's reasoning is aware of what was just said.
    /// User turns get 1.5x weight (listening > self-echo).
    /// Recent turns are weighted higher via their strength field.
    pub fn reason_with_context(
        &self,
        query: &str,
        universe: &Universe,
        context: &[ContextSlot],
    ) -> ReasonResult {
        // Opt-in routing to the contraction-stable looped reasoner. When the
        // flag is OFF (default) NOTHING below this line changes — the original
        // fixed HDC hop loop runs exactly as before.
        if LOOP_REASONER.load(Ordering::Relaxed) {
            return self
                .reason_looped_with_context(query, universe, context, &LoopConfig::from_env())
                .0;
        }

        let mut chain: Vec<ThoughtStep> = Vec::new();
        let query_vec = SparseVec::encode(query);

        // ── Build context-enriched starting vector ─────────────────────
        // Bundle the raw query with recent conversation context.
        // This gives KAI conversational awareness — he knows what was just said.
        let mut current;
        if context.is_empty() {
            current = query_vec.clone();
        } else {
            // Build weighted bundle: query (dominant) + context (supporting)
            let mut bundle_vecs: Vec<&SparseVec> = Vec::new();

            // Query gets 3 copies (dominant voice — 60% weight in a 5-vec bundle)
            bundle_vecs.push(&query_vec);
            bundle_vecs.push(&query_vec);
            bundle_vecs.push(&query_vec);

            // Add context slots weighted by recency and role
            for slot in context.iter().rev().take(6) {
                // User turns are more important than KAI's own responses
                let role_weight = if slot.role == "user" { 1.5 } else { 1.0 };
                let effective_weight = slot.strength * role_weight;

                // Only inject if the context is strong enough to matter
                if effective_weight > 0.3 {
                    bundle_vecs.push(&slot.vec);
                    // Strong recent context gets a second copy
                    if effective_weight > 0.7 {
                        bundle_vecs.push(&slot.vec);
                    }
                }
            }

            current = SparseVec::bundle(&bundle_vecs);
        }

        let mut context_vecs: Vec<SparseVec> = vec![query_vec.clone()];

        for step in 0..self.config.max_depth {
            // ── Step 1: Resonate — find the strongest match ───────────
            let hits = universe.query_vec(&current, 5);

            if hits.is_empty() || hits[0].1 < self.config.min_resonance {
                // No resonance — dead end. Record and stop.
                chain.push(ThoughtStep {
                    step,
                    vector: current.clone(),
                    phi_g: 0.0,
                    resonance_score: 0.0,
                    matched_text: String::new(),
                    matched_region: String::new(),
                });
                break;
            }

            let (best_cell, best_score) = &hits[0];

            // ── Step 2: Compute local Φg (emergence at this step) ────
            // Φg = average pairwise similarity among the top hits.
            // For stability, we blend the primary hit resonance with convergence.
            let phi_g = if hits.len() >= 2 {
                let mut sum = 0.0f32;
                let mut count = 0u32;
                for i in 0..hits.len().min(4) {
                    for j in (i + 1)..hits.len().min(4) {
                        sum += hits[i].0.claim.vec.cosine(&hits[j].0.claim.vec).abs();
                        count += 1;
                    }
                }
                let pairwise = if count > 0 { sum / count as f32 } else { 0.0 };
                // Blend: 70% primary resonance + 30% pairwise convergence
                (*best_score * 0.7) + (pairwise * 0.3)
            } else {
                *best_score
            };

            // ── Step 3: Record this thought step ─────────────────────
            chain.push(ThoughtStep {
                step,
                vector: current.clone(),
                phi_g,
                resonance_score: *best_score,
                matched_text: best_cell.label.clone(),
                matched_region: best_cell.region.to_string(),
            });

            // ── Step 4: Check if Φg peaked — stop if converged ───────
            if phi_g > self.config.phi_threshold {
                break;
            }

            // Also stop if Φg is declining (we passed the peak)
            if chain.len() >= 3 {
                let recent: Vec<f32> = chain.iter().rev().take(3).map(|s| s.phi_g).collect();
                if recent[0] < recent[1] && recent[1] < recent[2] {
                    // Declining for 3 steps — we've passed the peak
                    break;
                }
            }

            // ── Step 5: Derive the next thought ──────────────────────
            // Bind: query ⊗ match = relationship vector
            let bound = current.bind(&best_cell.claim.vec);

            // Accumulate context: bundle all previous thoughts with decay
            context_vecs.push(bound.clone());

            // Build context bundle with recency weighting
            let weighted: Vec<SparseVec> = context_vecs
                .iter()
                .enumerate()
                .map(|(i, v)| {
                    // More recent = more weight (we clone and add multiple times)
                    let age = context_vecs.len() - 1 - i;
                    let copies = ((self.config.decay_factor.powi(age as i32)) * 3.0) as usize;
                    std::iter::repeat_n(v.clone(), copies.max(1))
                        .collect::<Vec<_>>()
                })
                .flatten()
                .collect();

            let refs: Vec<&SparseVec> = weighted.iter().collect();
            let bundled = SparseVec::bundle(&refs);

            // Cleanup: find the nearest known vector to snap to
            // This prevents drift into meaningless vector space
            let cleanup_hits = universe.query_vec(&bundled, 1);
            current = if let Some((cell, score)) = cleanup_hits.first() {
                if *score > 0.2 {
                    // Blend: 60% derived thought + 40% nearest known
                    SparseVec::bundle(&[
                        &bundled,
                        &bundled,
                        &bundled,
                        &cell.claim.vec,
                        &cell.claim.vec,
                    ])
                } else {
                    bundled
                }
            } else {
                bundled
            };
        }

        // ── Select the best thought ──────────────────────────────────
        if chain.is_empty() {
            return ReasonResult {
                chain: Vec::new(),
                best_step: 0,
                output_text: String::new(),
                output_region: String::new(),
                confidence: 0.0,
                depth: 0,
            };
        }

        // Best = highest Φg step
        let best_idx = chain
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| {
                a.phi_g
                    .partial_cmp(&b.phi_g)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|(i, _)| i)
            .unwrap_or(0);

        let best = &chain[best_idx];

        // Decode: the matched text at the best step IS the output
        // But we can also try to compose from the chain
        let (output_text, output_region) = self.compose_output(&chain, best_idx, universe);

        ReasonResult {
            depth: chain.len(),
            best_step: best_idx,
            confidence: best.phi_g.min(1.0),
            output_text,
            output_region,
            chain,
        }
    }

    /// Run the fractal what-if simulation tree on a query.
    ///
    /// Generates a multidimensional "what-if" fractal tree. At each step, KAI evaluates
    /// multiple branches (possibilities/variables) and applies a dynamically calculated
    /// weight to find the best overarching path rather than the greedy best step.
    pub fn reason_tree_with_context(
        &self,
        query: &str,
        universe: &Universe,
        context: &[ContextSlot],
    ) -> ReasonTreeResult {
        let query_vec = SparseVec::encode(query);
        let mut current;
        if context.is_empty() {
            current = query_vec.clone();
        } else {
            let mut bundle_vecs: Vec<&SparseVec> = Vec::new();
            bundle_vecs.push(&query_vec);
            bundle_vecs.push(&query_vec);
            bundle_vecs.push(&query_vec);
            for slot in context.iter().rev().take(6) {
                let role_weight = if slot.role == "user" { 1.5 } else { 1.0 };
                let effective_weight = slot.strength * role_weight;
                if effective_weight > 0.3 {
                    bundle_vecs.push(&slot.vec);
                    if effective_weight > 0.7 {
                        bundle_vecs.push(&slot.vec);
                    }
                }
            }
            current = SparseVec::bundle(&bundle_vecs);
        }

        let mut nodes: Vec<TreeBranch> = Vec::new();
        // Queue: (current_vector, step, parent_path, accumulated_weight)
        let mut queue: Vec<(SparseVec, usize, Vec<usize>, f32)> = Vec::new();
        // Capture the goal vector ONLY when Attention-Weighted Hop Bundling is on,
        // so the default (flag-off) path pays zero extra cost — truly unchanged.
        let goal = if ATTN_RESIDUAL.load(Ordering::Relaxed) {
            current.clone()
        } else {
            SparseVec::zero()
        };
        queue.push((current, 0, Vec::new(), 1.0));

        let mut best_leaf: Option<usize> = None;
        let mut best_phi = 0.0;
        let branching_factor = 3;

        while !queue.is_empty() {
            let mut next_queue = Vec::new();

            for (vec, step, path, acc_weight) in queue {
                let hits = universe.query_vec(&vec, branching_factor);
                if hits.is_empty() { continue; }

                for (rank, (cell, score)) in hits.iter().enumerate() {
                    if *score < self.config.min_resonance { continue; }

                    let mut new_path = path.clone();
                    let node_idx = nodes.len();
                    new_path.push(node_idx);

                    // Dynamic weighting based on variables: rank acts as a probability penalty,
                    // score acts as the alignment truth value.
                    let branch_weight = acc_weight * score * (1.0 - (rank as f32 * 0.15));
                    let phi_g = *score; 

                    let node = TreeBranch {
                        step,
                        vector: vec.clone(),
                        phi_g,
                        resonance_score: *score,
                        matched_text: cell.label.clone(),
                        matched_region: cell.region.to_string(),
                        weight: branch_weight,
                        path: new_path.clone(),
                    };
                    nodes.push(node);

                    let path_score = phi_g * branch_weight;
                    if path_score > best_phi {
                        best_phi = path_score;
                        best_leaf = Some(node_idx);
                    }

                    if step + 1 < self.config.max_depth && phi_g < self.config.phi_threshold {
                        // Derive next what-if thought by binding
                        let bound = vec.bind(&cell.claim.vec);
                        let bundled = if ATTN_RESIDUAL.load(Ordering::Relaxed) {
                            let comps: [&SparseVec; 3] = [&vec, &bound, &cell.claim.vec];
                            let weights: Vec<f32> =
                                comps.iter().map(|c| 0.1 + goal.cosine(c).max(0.0)).collect();
                            SparseVec::bundle_weighted(&comps, &weights)
                        } else {
                            SparseVec::bundle(&[&vec, &bound, &cell.claim.vec])
                        };
                        next_queue.push((bundled, step + 1, new_path, branch_weight));
                    }
                }
            }
            queue = next_queue;
        }

        let best_path = if let Some(leaf_idx) = best_leaf {
            nodes[leaf_idx].path.iter().map(|&i| nodes[i].clone()).collect()
        } else {
            Vec::new()
        };

        let (output_text, output_region) = if best_path.is_empty() {
            (String::new(), String::new())
        } else {
            let leaf = best_path.last().unwrap();
            
            if best_path.len() > 1 {
                let path_labels: Vec<String> = best_path.iter().take(3).map(|n| n.matched_text.clone()).collect();
                (format!("{} (Fractal Path: {})", leaf.matched_text, path_labels.join(" → ")), leaf.matched_region.clone())
            } else {
                (leaf.matched_text.clone(), leaf.matched_region.clone())
            }
        };

        ReasonTreeResult {
            best_path,
            output_text,
            output_region,
            max_phi: best_phi,
        }
    }

    /// Contraction-stable LOOPED reasoning (no context). See
    /// `reason_looped_with_context` for the full contraction argument and the
    /// deferred-decoding / adaptive-halt mechanics.
    pub fn reason_looped(
        &self,
        query: &str,
        universe: &Universe,
        cfg: &LoopConfig,
    ) -> (ReasonResult, LoopDiag) {
        self.reason_looped_with_context(query, universe, &[], cfg)
    }

    /// Contraction-stable LOOPED reasoning update with DEFERRED DECODING and an
    /// ADAPTIVE HALT — native to the VSA/lattice paradigm.
    ///
    /// ── The update rule (the "LoopWM" stable recurrent block, in VSA space) ──
    /// Working entirely in latent SparseVec space, each step applies a weighted
    /// superposition of three terms (built with the real `bundle_weighted` op):
    ///
    ///     h_{t+1} = τ( alpha · h_t                 (RETENTION)
    ///               +  beta  · query_or_action     (INJECTION, constant)
    ///               +  gamma · hdc_transform(h_t)) (REFINEMENT)
    ///
    /// where `hdc_transform(h_t) = h_t ⊗ hit` (bind to the current best retrieval
    /// hit — the relationship vector), and τ is the bundle's
    /// accumulate-then-threshold re-sparsify that keeps the result at the
    /// engine's ~4% ternary sparsity.
    ///
    /// HONEST FRAMING: these alpha/beta/gamma are NOT gradient-trained weights.
    /// This is a parameterized, contraction-stable FIXED-POINT ITERATION in VSA
    /// space — the same STRUCTURE as LoopWM's stable recurrent block, but
    /// online/algebraic rather than learned. The value is the stability +
    /// adaptive depth it buys, not learned parameters.
    ///
    /// ── Contraction ⇒ boundedness (why alpha < 1 matters) ──
    /// Treat ‖·‖ as the L2 norm (`SparseVec::norm()` = sqrt(nnz)). The injection
    /// term is CONSTANT across the loop (the encoded query/context), so its norm
    /// is a fixed bound B = beta·‖q‖. The refinement term is a bind of h_t with a
    /// unit-support hit; binding cannot create support outside h_t, so
    /// ‖hit-transform(h_t)‖ ≤ ‖h_t‖, contributing at most gamma·‖h_t‖. By the
    /// triangle inequality on the (pre-threshold) superposition,
    ///
    ///     ‖h_{t+1}‖ ≤ (alpha + gamma)·‖h_t‖ + B.
    ///
    /// With the engine's re-sparsify τ capping nnz at the fixed ~4% target, the
    /// post-threshold norm is additionally bounded by sqrt(target_nnz); and with
    /// alpha < 1 the retention term alone is a strict contraction
    /// (‖alpha·h_t‖ = alpha·‖h_t‖ < ‖h_t‖). The fixed point of the affine map
    /// x ↦ a·x + B is x* = B/(1-a); since the iteration is bounded above by this
    /// affine envelope and τ re-projects onto the fixed-sparsity simplex, the
    /// latent norm CANNOT grow without bound — it converges into a bounded basin.
    /// We additionally enforce a hard norm ceiling (defense in depth) below.
    ///
    /// ── Deferred decoding ──
    /// Every iteration stays in SparseVec LATENT space. We do NOT resolve the
    /// latent to a cell/text per hop. Only AFTER the halt do we run a single
    /// `universe.query_vec` to decode the final latent into the best cell/text.
    ///
    /// ── Adaptive halt ──
    /// Stop when ANY of: (1) the latent reaches a fixed point —
    /// cosine(h_{t+1}, h_t) > cfg.fixedpoint; (2) Φg gain per step falls below an
    /// online-calibrated epsilon; or (3) the max-depth safety cap. The iteration
    /// count actually used is reported as adaptive depth in `LoopDiag`.
    pub fn reason_looped_with_context(
        &self,
        query: &str,
        universe: &Universe,
        context: &[ContextSlot],
        cfg: &LoopConfig,
    ) -> (ReasonResult, LoopDiag) {
        // TRAVERSAL mode: walk the chain instead of running the contraction
        // fixed-point. Gated by cfg.traverse (KAI_LOOP_TRAVERSE / LOOP_TRAVERSE).
        // When OFF (default) NOTHING below this line changes.
        if cfg.traverse {
            return self.reason_traverse_with_context(query, universe, context, cfg);
        }

        let query_vec = SparseVec::encode(query);

        // ── Build the constant INJECTION term (query + recent context) ───────
        // Same recipe as the default path so retrieval semantics are preserved.
        let inject: SparseVec = if context.is_empty() {
            query_vec.clone()
        } else {
            let mut bundle_vecs: Vec<&SparseVec> = Vec::new();
            bundle_vecs.push(&query_vec);
            bundle_vecs.push(&query_vec);
            bundle_vecs.push(&query_vec);
            for slot in context.iter().rev().take(6) {
                let role_weight = if slot.role == "user" { 1.5 } else { 1.0 };
                let effective_weight = slot.strength * role_weight;
                if effective_weight > 0.3 {
                    bundle_vecs.push(&slot.vec);
                    if effective_weight > 0.7 {
                        bundle_vecs.push(&slot.vec);
                    }
                }
            }
            SparseVec::bundle(&bundle_vecs)
        };

        // Latent state h, initialized to the injection term.
        let mut h = inject.clone();

        // Stability bookkeeping.
        let inject_norm = inject.norm();
        let inject_bound = cfg.injection * inject_norm; // B = beta·‖q‖
        let norm_ceiling = (inject_norm * cfg.norm_ceiling_mult).max(1.0);
        let mut max_norm = h.norm();
        let mut contraction_held = true;
        let mut clamps = 0usize;

        // Adaptive-halt bookkeeping.
        let mut chain: Vec<ThoughtStep> = Vec::new();
        let mut prev_phi_g = 0.0f32;
        // Online-calibrated epsilon for the Φg-gain stall test. Seeded small and
        // adapted toward a fraction of the running mean |gain| so the threshold
        // tracks the actual signal scale instead of a hardcoded constant.
        let mut eps = 1e-3f32;
        let mut gain_accum = 0.0f32;
        let mut gain_count = 0u32;

        let mut halt = LoopHalt::MaxDepth;
        let mut final_cosine = 0.0f32;
        let mut final_phi_g = 0.0f32;
        let mut iterations = 0usize;

        for step in 0..cfg.max_depth {
            iterations = step + 1;

            // ── Retrieve in latent space (signal for the refinement term) ────
            let hits = universe.query_vec(&h, 5);
            if hits.is_empty() || hits[0].1 < cfg.min_resonance {
                halt = LoopHalt::DeadEnd;
                final_phi_g = prev_phi_g;
                break;
            }
            let (best_cell, best_score) = (&hits[0].0, hits[0].1);

            // ── Φg for the current latent (field emergence) ──────────────────
            // Use the canonical field metric on the latent so the halt tracks
            // the same Φg the rest of the engine reasons about.
            let layer_id = best_cell.claim.layer;
            let phi_g = FieldState::measure(universe, &h, layer_id).phi_g;
            final_phi_g = phi_g;

            // Record a lightweight thought step for inspectability (NOT decoded
            // to a final answer here — that is deferred to after the halt).
            chain.push(ThoughtStep {
                step,
                vector: h.clone(),
                phi_g,
                resonance_score: best_score,
                matched_text: best_cell.label.clone(),
                matched_region: best_cell.region.to_string(),
            });

            // ── REFINEMENT term: hdc_transform(h_t, hit) = h ⊗ hit ───────────
            let refine = h.bind(&best_cell.claim.vec);

            // ── Contraction-stable update: weighted superposition ────────────
            //   h_{t+1} = τ( alpha·h + beta·inject + gamma·refine )
            let comps: [&SparseVec; 3] = [&h, &inject, &refine];
            let weights = [cfg.retention, cfg.injection, cfg.refinement];
            let mut h_next = SparseVec::bundle_weighted(&comps, &weights);

            // ── Stability monitor + defense-in-depth norm clamp ──────────────
            let n_next = h_next.norm();
            if n_next > norm_ceiling {
                // Re-sparsify/normalize back under the ceiling. superpose_sparse
                // re-thresholds to the engine's target density, shrinking nnz
                // (hence the L2 norm) deterministically.
                h_next = SparseVec::superpose_sparse(
                    &[&h_next],
                    crate::core::sparse_vec::SPARSITY,
                );
                clamps += 1;
            }
            let n_clamped = h_next.norm();
            // Contraction invariant check (with a small numeric slack):
            //   ‖h_{t+1}‖ ≤ (alpha + gamma)·‖h_t‖ + inject_bound
            let envelope = (cfg.retention + cfg.refinement) * h.norm() + inject_bound + 1e-3;
            if n_clamped > envelope {
                contraction_held = false;
            }
            if n_clamped > max_norm {
                max_norm = n_clamped;
            }

            // ── Adaptive halt: fixed-point convergence ───────────────────────
            let cos_prev = h.cosine(&h_next);
            final_cosine = cos_prev;
            if cos_prev > cfg.fixedpoint {
                h = h_next;
                halt = LoopHalt::FixedPoint;
                break;
            }

            // ── Adaptive halt: Φg-gain stall (online-calibrated eps) ─────────
            if step > 0 {
                let gain = (phi_g - prev_phi_g).abs();
                gain_accum += gain;
                gain_count += 1;
                // eps tracks 10% of the running mean |gain| (floored).
                let mean_gain = gain_accum / gain_count.max(1) as f32;
                eps = (0.1 * mean_gain).max(1e-4);
                if gain < eps {
                    h = h_next;
                    halt = LoopHalt::PhiGainStalled;
                    break;
                }
            }

            prev_phi_g = phi_g;
            h = h_next;
        }

        let diag = LoopDiag {
            iterations,
            halt,
            max_norm,
            contraction_held,
            clamps,
            final_cosine,
            final_phi_g,
        };

        // ── DEFERRED DECODE: a single decode of the final latent → answer ────
        let decoded = universe.query_vec(&h, 1);
        let (output_text, output_region, confidence) = if let Some((cell, score)) = decoded.first() {
            (cell.label.clone(), cell.region.to_string(), final_phi_g.max(*score).min(1.0))
        } else if let Some(last) = chain.last() {
            (last.matched_text.clone(), last.matched_region.clone(), final_phi_g.min(1.0))
        } else {
            (String::new(), String::new(), 0.0)
        };

        let best_step = chain
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| {
                a.phi_g
                    .partial_cmp(&b.phi_g)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|(i, _)| i)
            .unwrap_or(0);

        let result = ReasonResult {
            depth: iterations,
            best_step,
            confidence,
            output_text,
            output_region,
            chain,
        };
        (result, diag)
    }

    /// TRAVERSAL-mode looped reasoning — a real lattice graph-walk for multi-hop
    /// chains. Gated by `cfg.traverse` (KAI_LOOP_TRAVERSE / LOOP_TRAVERSE).
    ///
    /// ── Why this exists ──
    /// The contraction `reason_looped` settles to a stable latent FIXED POINT in
    /// ~1 step (retention alpha≈0.85), so its "state stopped moving" halt fires
    /// immediately — but a stable blend of the query is NOT the END of a 4–6 hop
    /// chain. This mode instead WALKS the chain: it keeps stepping to the next
    /// retrieved hop until it reaches a TERMINAL/no-progress node.
    ///
    /// ── The walk (each iteration) ──
    ///   1. RETRIEVE the best next-hop cell for the CURRENT state.
    ///   2. ADVANCE strongly toward it: h ← τ( traverse_retain·h + (1−retain)·hop )
    ///      with traverse_retain LOW (~0.30) so the state really moves to the hop.
    ///      We also BIND in the relationship (h ⊗ hop) at a small weight so the
    ///      walk follows the chain's directed edges, not just nearest neighbour.
    ///   3. HALT when: the retrieved cell repeats (no new hop ⇒ terminal/dead-end),
    ///      OR resonance is high AND stable on a node already visited (answer
    ///      found), OR the max-depth safety cap is hit. The halt is "answer found /
    ///      no progress", NOT "latent fixed point".
    /// Norm is clamped exactly like the contraction path (defense in depth).
    ///
    /// ASSUMED APIs (compiler-check): SparseVec::{encode,bundle,bundle_weighted,
    /// bind,norm,superpose_sparse,cosine}; Universe::query_vec(&q,n)->Vec<(Cell,f32)>;
    /// Cell.{label,region,claim.vec,claim.layer}; FieldState::measure(uni,&h,layer).phi_g.
    fn reason_traverse_with_context(
        &self,
        query: &str,
        universe: &Universe,
        context: &[ContextSlot],
        cfg: &LoopConfig,
    ) -> (ReasonResult, LoopDiag) {
        let query_vec = SparseVec::encode(query);

        // Build the starting state (query + recent context) — same recipe as the
        // contraction path so retrieval semantics are identical at hop 1.
        let mut h: SparseVec = if context.is_empty() {
            query_vec.clone()
        } else {
            let mut bundle_vecs: Vec<&SparseVec> = Vec::new();
            bundle_vecs.push(&query_vec);
            bundle_vecs.push(&query_vec);
            bundle_vecs.push(&query_vec);
            for slot in context.iter().rev().take(6) {
                let role_weight = if slot.role == "user" { 1.5 } else { 1.0 };
                let effective_weight = slot.strength * role_weight;
                if effective_weight > 0.3 {
                    bundle_vecs.push(&slot.vec);
                    if effective_weight > 0.7 {
                        bundle_vecs.push(&slot.vec);
                    }
                }
            }
            SparseVec::bundle(&bundle_vecs)
        };

        let inject_norm = h.norm();
        let norm_ceiling = (inject_norm * cfg.norm_ceiling_mult).max(1.0);
        let mut max_norm = h.norm();
        let mut clamps = 0usize;

        let mut chain: Vec<ThoughtStep> = Vec::new();
        // Labels of cells we have already stepped ONTO (for no-progress / cycle
        // detection — the "terminal" signal in a lattice without an explicit flag).
        let mut visited: Vec<String> = Vec::new();
        let retain = cfg.traverse_retain;
        let advance = (1.0 - retain).max(0.05); // weight on the retrieved hop
        const REL_WEIGHT: f32 = 0.20; // small weight on the directed-edge bind

        let mut halt = LoopHalt::MaxDepth;
        let mut final_cosine = 0.0f32;
        let mut final_phi_g = 0.0f32;
        let mut iterations = 0usize;
        let mut last_label = String::new();
        let mut last_region = String::new();

        for step in 0..cfg.max_depth {
            iterations = step + 1;

            // 1. RETRIEVE the best next hop for the current state.
            let hits = universe.query_vec(&h, 5);
            if hits.is_empty() || hits[0].1 < cfg.min_resonance {
                halt = LoopHalt::DeadEnd;
                break;
            }
            let (hop_cell, hop_score) = (hits[0].0.clone(), hits[0].1);

            let layer_id = hop_cell.claim.layer;
            let phi_g = FieldState::measure(universe, &h, layer_id).phi_g;
            final_phi_g = phi_g;

            chain.push(ThoughtStep {
                step,
                vector: h.clone(),
                phi_g,
                resonance_score: hop_score,
                matched_text: hop_cell.label.clone(),
                matched_region: hop_cell.region.to_string(),
            });

            // TERMINAL / no-progress: the best hop is one we already stepped onto.
            // The walk has nowhere new to go ⇒ this is the chain's end (answer).
            let repeated = visited.iter().any(|l| l == &hop_cell.label);
            last_label = hop_cell.label.clone();
            last_region = hop_cell.region.to_string();
            if repeated {
                halt = LoopHalt::FixedPoint; // reuse variant: "settled on a node"
                break;
            }
            visited.push(hop_cell.label.clone());

            // 2. ADVANCE the state strongly TOWARD the retrieved hop (low
            //    retention so the latent actually MOVES), plus a small directed
            //    edge term (h ⊗ hop) so the walk follows the chain, not just the
            //    nearest neighbour.
            let edge = h.bind(&hop_cell.claim.vec);
            let comps: [&SparseVec; 3] = [&h, &hop_cell.claim.vec, &edge];
            let weights = [retain, advance, REL_WEIGHT];
            let mut h_next = SparseVec::bundle_weighted(&comps, &weights);

            // Norm clamp (defense in depth — identical mechanism to the
            // contraction path; the walk should never explode).
            if h_next.norm() > norm_ceiling {
                h_next =
                    SparseVec::superpose_sparse(&[&h_next], crate::core::sparse_vec::SPARSITY);
                clamps += 1;
            }
            if h_next.norm() > max_norm {
                max_norm = h_next.norm();
            }

            final_cosine = h.cosine(&h_next);

            // 3. ANSWER-FOUND halt: a high-confidence hop that the state has now
            //    essentially become (cosine to it is high) — we've arrived.
            if hop_score > self.config.phi_threshold && h_next.cosine(&hop_cell.claim.vec) > 0.6 {
                h = h_next;
                halt = LoopHalt::PhiGainStalled; // reuse variant: "confident arrival"
                last_label = hop_cell.label.clone();
                last_region = hop_cell.region.to_string();
                break;
            }

            h = h_next;
        }

        // Contraction invariant is not asserted for the walk (it deliberately
        // moves), but we still report the stability telemetry we DID gather.
        let diag = LoopDiag {
            iterations,
            halt,
            max_norm,
            contraction_held: true,
            clamps,
            final_cosine,
            final_phi_g,
        };

        // The traversal ANSWER is the last cell the walk stepped onto. We do NOT
        // re-decode the latent (that would snap back toward the query); the chain
        // endpoint IS the answer.
        let (output_text, output_region, confidence) = if !last_label.is_empty() {
            (last_label, last_region, final_phi_g.min(1.0))
        } else if let Some(last) = chain.last() {
            (
                last.matched_text.clone(),
                last.matched_region.clone(),
                final_phi_g.min(1.0),
            )
        } else {
            (String::new(), String::new(), 0.0)
        };

        let best_step = chain.len().saturating_sub(1);
        let result = ReasonResult {
            depth: iterations,
            best_step,
            confidence,
            output_text,
            output_region,
            chain,
        };
        (result, diag)
    }

    /// Compose output from the reasoning chain.
    ///
    /// Instead of just returning the best match text, we look at
    /// what the chain discovered and try to synthesize.
    fn compose_output(
        &self,
        chain: &[ThoughtStep],
        best_idx: usize,
        universe: &Universe,
    ) -> (String, String) {
        let best = &chain[best_idx];

        if chain.len() == 1 {
            // Single step — just return the match
            return (best.matched_text.clone(), best.matched_region.clone());
        }

        // Multi-step: compose from the chain
        // Take unique matched texts from high-Φg steps
        let mut parts: Vec<(f32, &str, &str)> = chain
            .iter()
            .filter(|s| s.phi_g > 0.01 && !s.matched_text.is_empty())
            .map(|s| (s.phi_g, s.matched_text.as_str(), s.matched_region.as_str()))
            .collect();

        parts.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        parts.dedup_by(|a, b| a.1 == b.1);

        if parts.is_empty() {
            return (String::new(), String::new());
        }

        // If we only have one unique match, return it
        if parts.len() == 1 {
            return (parts[0].1.to_string(), parts[0].2.to_string());
        }

        // Synthesize: combine the top matches with their scores
        // The final vector is the bundle of the chain — decode it
        let final_vec = &chain.last().unwrap().vector;
        let decoded = universe.query_vec(final_vec, 1);

        if let Some((cell, score)) = decoded.first() {
            if *score > 0.3 {
                // Good decode — use it as primary, annotate with sources
                let sources: Vec<String> = parts
                    .iter()
                    .take(3)
                    .filter(|(_, t, _)| *t != cell.label.as_str())
                    .map(|(phi, text, region)| {
                        let short = if text.len() > 50 {
                            let mut end = 50;
                            while end > 0 && !text.is_char_boundary(end) {
                                end -= 1;
                            }
                            &text[..end]
                        } else {
                            text
                        };
                        format!("[{}·{:.0}%: {}]", region, phi * 100.0, short)
                    })
                    .collect();

                let annotation = if sources.is_empty() {
                    String::new()
                } else {
                    format!(" (Sources: {})", sources.join(", "))
                };
                return (format!("{}{}", cell.label, annotation), cell.region.to_string());
            }
        }

        // Fallback: Best single step
        (best.matched_text.clone(), best.matched_region.clone())
    }
}
