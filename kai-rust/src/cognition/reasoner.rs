/// RSHL Reasoner — Iterative Resonance Chain-of-Thought
///
/// This is how KAI does LLM-level reasoning without being an LLM.
///
/// Instead of a single cosine lookup, the reasoner:
///   1. Encodes the query as a sparse ternary vector
///   2. Resonates against the universe to find the strongest match
///   3. Binds query ⊗ match → creates a "derived thought" vector
///   4. Bundles the derived thought with context → "next thought"
///   5. Repeats until Φg peaks or max depth reached
///   6. Decodes the best thought vector back to text
///
/// Each step is a full geometric operation — no transformer math,
/// no attention heads, no softmax. Pure HDC algebra.
///
/// The key insight: binding two vectors creates a NEW vector that
/// captures the RELATIONSHIP between them. Bundling accumulates
/// evidence. The chain naturally gravitates toward coherent thought.

use crate::core::{SparseVec, Universe, FieldState};

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

/// Configuration for the reasoner.
pub struct ReasonerConfig {
    pub max_depth: usize,
    pub phi_threshold: f32,     // Stop early if Φg exceeds this
    pub min_resonance: f32,     // Minimum cosine to consider a match
    pub decay_factor: f32,      // How much older thoughts fade in the bundle
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

impl Reasoner {
    pub fn new() -> Self {
        Self { config: ReasonerConfig::default() }
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
            // Φg = average pairwise similarity among the top hits
            let phi_g = if hits.len() >= 2 {
                let mut sum = 0.0f32;
                let mut count = 0u32;
                for i in 0..hits.len().min(4) {
                    for j in (i + 1)..hits.len().min(4) {
                        sum += hits[i].0.vec.cosine(&hits[j].0.vec).abs();
                        count += 1;
                    }
                }
                if count > 0 { sum / count as f32 } else { 0.0 }
            } else {
                *best_score
            };

            // ── Step 3: Record this thought step ─────────────────────
            chain.push(ThoughtStep {
                step,
                vector: current.clone(),
                phi_g,
                resonance_score: *best_score,
                matched_text: best_cell.text.clone(),
                matched_region: best_cell.region.clone(),
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
            let bound = current.bind(&best_cell.vec);

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
                    std::iter::repeat(v.clone()).take(copies.max(1)).collect::<Vec<_>>()
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
                    SparseVec::bundle(&[&bundled, &bundled, &bundled, &cell.vec, &cell.vec])
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
            .max_by(|(_, a), (_, b)| a.phi_g.partial_cmp(&b.phi_g).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(i, _)| i)
            .unwrap_or(0);

        let best = &chain[best_idx];

        // Decode: the matched text at the best step IS the output
        // But we can also try to compose from the chain
        let output = self.compose_output(&chain, best_idx, universe);

        ReasonResult {
            depth: chain.len(),
            best_step: best_idx,
            confidence: best.phi_g.min(1.0),
            output_text: output.0,
            output_region: output.1,
            chain,
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
                    .filter(|(_, t, _)| *t != cell.text.as_str())
                    .map(|(phi, text, region)| {
                        let short = if text.len() > 50 { &text[..50] } else { text };
                        format!("[{}·{:.0}%: {}]", region, phi * 100.0, short)
                    })
                    .collect();

                let mut output = cell.text.clone();
                if !sources.is_empty() {
                    output = format!("{} — via {}", output, sources.join(", "));
                }
                return (output, cell.region.clone());
            }
        }

        // Fallback: return the best step's match
        (best.matched_text.clone(), best.matched_region.clone())
    }
}

impl Default for Reasoner {
    fn default() -> Self {
        Self::new()
    }
}
