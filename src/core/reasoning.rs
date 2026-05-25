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
use crate::core::{SparseVec, Universe};

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
                        let bundled = SparseVec::bundle(&[&vec, &bound, &cell.claim.vec]);
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
