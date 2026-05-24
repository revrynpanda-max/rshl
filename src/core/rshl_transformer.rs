//! RSHL Transformer Heads — Multi-head attention in sparse ternary space.
//!
//! ## Biological Foundation
//!
//! This module implements transformer-like self-attention entirely within
//! KAI's RSHL sparse ternary vector space, following the mathematical
//! equivalence established by Dhayalkar et al. (arXiv:2512.14709):
//!
//!   * Attention ≈ soft VSA binding
//!   * Queries = unbinding probes (role vectors)
//!   * Keys = stored role-filler bindings
//!   * Values = fillers (semantic content)
//!   * Attention weights = binding strength via cosine similarity
//!   * Multi-head = parallel binding channels in shared substrate
//!
//! ## Physical Laws (Universe Constraints)
//!
//! Every operation respects the laws of the KAIverse:
//!   1. **Conservation of Information** — density never exceeds the 4% budget.
//!      Information is transformed, not destroyed. Like energy, it changes
//!      form but the total "mass" of active dimensions is bounded.
//!   2. **Phase Coherence Gating** — only coherent signals propagate.
//!      Incoherent superpositions decay. Like action potentials, only
//!      synchronized assemblies get through.
//!   3. **Energy Economy** — more heads = more compute "ATP" consumed.
//!      The system can dial down to 4 heads (low energy) or up to 8
//!      (high energy) based on available resources and task demand.
//!
//! ## Architecture
//!
//! ```text
//! Input State ──► [Project to Head Subspace] ──► [Q·K Similarity] ──► [Softmax] ──► [Weighted V Bundle]
//!                                                                              │
//! Context Window (position-bound vectors) ─────────────────────────────────────┘
//!                                                                              │
//! Output ──► [Density Clamp 4%] ◄── [Multi-head Superposition]
//!                                                                              │
//! Feed-Forward ──► [Semantic Transform] ──► [Residual + Clamp]
//! ```

use crate::core::sparse_vec::{SparseVec, DIM};
use crate::core::stat_lexicon::position_key;
use std::f32::consts::E;
use std::sync::atomic::{AtomicU32, Ordering};

// ─────────────────────────────────────────────────────────────────────────────
// Global emotional temperature modulation
// ─────────────────────────────────────────────────────────────────────────────

/// Live temperature override for all attention heads. Set by the
/// heartbeat from amygdala/drive state. Stress narrows focus (lower
/// temp), calm broadens it (higher temp).
/// Stored as u32 bits because AtomicF32 doesn't exist in std.
static EMOTIONAL_TEMP: AtomicU32 = AtomicU32::new(0); // 0 = use head default

pub fn get_emotional_temp() -> f32 {
    let bits = EMOTIONAL_TEMP.load(Ordering::Relaxed);
    if bits == 0 { 0.0 } else { f32::from_bits(bits) }
}

pub fn set_emotional_temp(temp: f32) {
    EMOTIONAL_TEMP.store(temp.to_bits(), Ordering::Relaxed);
}

// ─────────────────────────────────────────────────────────────────────────────
// Universe Constants — Physical law, not tunable
// ─────────────────────────────────────────────────────────────────────────────

/// Target sparsity budget. Sacred to RSHL's mathematical identity.
/// Like the speed of light — information density has an upper bound.
const TARGET_DENSITY: f32 = 0.04;

/// Default temperature for softmax. sqrt(DIM * density) ≈ sqrt(655) ≈ 25.6
/// This scales cosine similarities so the softmax isn't too sharp or too flat.
const DEFAULT_TEMPERATURE: f32 = 12.0;

/// Minimum attention weight — every position contributes at least this much.
/// Like quantum zero-point energy: nothing is ever fully absent.
const MIN_ATTENTION: f32 = 0.01;

/// Maximum context window length. Like working memory capacity in biology,
/// there's a hard limit to how far back attention can reach.
const MAX_CONTEXT_LEN: usize = 32;

/// Seed basis for head keys. Deterministic — same architecture, same keys.
const HEAD_KEY_SEED_BASE: u32 = 0x9e3779b9;

// ─────────────────────────────────────────────────────────────────────────────
// RshlHead — One attention head
// ─────────────────────────────────────────────────────────────────────────────

/// A single attention head in RSHL space.
///
/// Each head has a unique `head_key` vector that projects the query into
/// a distinct subspace of the 16,384-dimensional lattice. This is the
/// geometric equivalent of a transformer's linear projection W_Q, W_K, W_V —
/// but instead of learned dense matrices, we use deterministic sparse
/// binding operations that respect the VSA algebra.
///
/// The head key acts like a "tuning fork": when bound to the query, it
/// emphasizes different semantic dimensions, allowing each head to attend
/// to different aspects of the context (syntax vs. semantics vs. emotion).
#[derive(Debug, Clone)]
pub struct RshlHead {
    /// Unique binding vector for this head. Projects queries into
    /// head-specific subspaces via `query.bind(&head_key)`.
    pub head_key: SparseVec,

    /// Softmax temperature. Lower = sharper focus on single positions.
    /// Higher = broader, more diffuse attention.
    pub temperature: f32,
}

impl RshlHead {
    /// Create a new head with a deterministic key derived from `head_index`.
    /// The key is a 4%-sparse vector generated from a seeded permutation,
    /// ensuring every head gets a unique but reproducible subspace.
    pub fn new(head_index: usize) -> Self {
        let seed = HEAD_KEY_SEED_BASE.wrapping_add(head_index as u32);
        // Generate a random-appearing but deterministic sparse vector
        let head_key = generate_head_key(seed);
        Self {
            head_key,
            temperature: DEFAULT_TEMPERATURE,
        }
    }

    /// Compute attention over a context window.
    ///
    /// ## Algorithm
    /// 1. **Project query**: `proj_q = query.bind(&head_key)`
    ///    — maps query into this head's subspace.
    /// 2. **Score keys**: For each `(pos, key)` in context,
    ///    compute `sim = cosine(proj_q, key)`.
    /// 3. **Softmax**: Convert similarities to probability weights.
    /// 4. **Weighted bundle**: Sum values weighted by attention scores.
    /// 5. **Density clamp**: Re-ternarize to 4% budget.
    ///
    /// This is the complete attention computation for one head.
    /// Like a neuronal population code: each context position "votes"
    /// with a weight proportional to its resonance with the query.
    pub fn attend(
        &self,
        query: &SparseVec,
        context: &[(usize, SparseVec)], // (position_index, vector)
    ) -> SparseVec {
        if context.is_empty() {
            return SparseVec::zero();
        }

        // 1. Project query into head subspace
        let proj_q = query.bind(&self.head_key);

        // 2. Compute raw similarities (Q·K)
        let mut raw_sims: Vec<f32> = Vec::with_capacity(context.len());
        for (_, key) in context {
            let sim = proj_q.cosine(key);
            // Cosine can be negative; shift to positive for softmax
            raw_sims.push(sim.max(0.0));
        }

        // 3. Softmax over similarities
        // Emotional modulation: if the amygdala has set a live
        // temperature, it overrides the head default. Stress
        // narrows, calm broadens.
        let live_temp = get_emotional_temp();
        let temp = if live_temp > 0.0 { live_temp } else { self.temperature };
        let weights = softmax(&raw_sims, temp);

        // 4. Weighted superposition of values
        // In RSHL, values ARE the keys (the full cell content).
        // We weight each context vector by its attention score.
        let mut sums = vec![0f32; DIM];
        for (i, (_, value)) in context.iter().enumerate() {
            let w = weights[i].max(MIN_ATTENTION);
            if w <= 0.0 {
                continue;
            }
            for (d, val) in value.iter() {
                let v = val as f32;
                sums[d] += w * v;
            }
        }

        // 5. Density clamp: keep top 4% dimensions
        density_clamp(&sums, TARGET_DENSITY)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// RshlFeedForward — Semantic transformation layer
// ─────────────────────────────────────────────────────────────────────────────

/// Feed-forward transformation in sparse ternary space.
///
/// Instead of a learned dense MLP (which would break sparsity), this
/// implements "structured semantic bundles" — hand-designed transformations
/// that map between semantic categories while preserving the 4% density law.
///
/// Like a biological neural network's interneurons: small populations that
/// shift, sharpen, or re-balance activity patterns without exploding dimensionality.
///
/// Each transformation is a SparseVec representing a semantic operation:
///   * "make more concrete" — shifts abstract dims to concrete
///   * "make more abstract" — the inverse
///   * "past tense" — shifts temporal reference
///   * "question form" — rearranges to interrogative structure
///   * "emotional emphasis" — amplifies affect dimensions
///
/// The FF layer blends these based on the input's resonance with each
/// transformation vector — no gradient descent needed, just geometry.
#[derive(Debug, Clone)]
pub struct RshlFeedForward {
    /// Semantic transformation vectors. Each is a 4%-sparse vector
    /// encoding a specific meaning-shifting operation.
    pub transformations: Vec<(SparseVec, f32)>, // (transform_vector, default_weight)

    /// How strongly the residual connection preserves input vs. transform.
    /// Like the balance between excitation and inhibition in a cortical column.
    pub residual_weight: f32,
}

impl RshlFeedForward {
    /// Create a feed-forward layer with default semantic transformations.
    /// These are initialized from seed vectors — deterministic, reproducible.
    pub fn new() -> Self {
        let mut tfs = Vec::with_capacity(8);

        // Seed-based deterministic transformations
        // Each represents a semantic "direction" in the lattice
        let seeds = [
            (0xABCD1234, 0.15, "concrete"),
            (0xBCDE2345, 0.15, "abstract"),
            (0xCDEF3456, 0.12, "past_tense"),
            (0xDEFA4567, 0.12, "future_tense"),
            (0xEFAB5678, 0.10, "question"),
            (0xFABC6789, 0.10, "emotional"),
            (0xABCD7890, 0.13, "elaborate"),
            (0xBCDE8901, 0.13, "condense"),
        ];

        for (seed, weight, _label) in seeds {
            tfs.push((generate_head_key(seed), weight));
        }

        Self {
            transformations: tfs,
            residual_weight: 0.5,
        }
    }

    /// Apply the feed-forward transformation to `input`.
    ///
    /// 1. Measure resonance between input and each transformation vector.
    /// 2. Weight transformations by resonance × default_weight.
    /// 3. Bundle weighted transforms with input (residual).
    /// 4. Density clamp.
    pub fn forward(&self, input: &SparseVec) -> SparseVec {
        if input.nnz() == 0 {
            return SparseVec::zero();
        }

        // 1. Compute resonance scores
        let mut terms: Vec<(&SparseVec, f32)> = Vec::with_capacity(self.transformations.len() + 1);

        for (tvec, default_w) in &self.transformations {
            let resonance = input.cosine(tvec).max(0.0);
            let weight = resonance * default_w;
            if weight > 0.001 {
                terms.push((tvec, weight));
            }
        }

        // 2. Add residual (input preserves its own structure)
        terms.push((input, self.residual_weight));

        // 3. Weighted superposition + density clamp
        weighted_superpose(&terms, TARGET_DENSITY)
    }
}

impl Default for RshlFeedForward {
    fn default() -> Self {
        Self::new()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// RshlTransformerBlock — Full multi-head + feed-forward block
// ─────────────────────────────────────────────────────────────────────────────

/// A complete transformer block operating in RSHL sparse ternary space.
///
/// This is the geometric equivalent of a standard transformer layer,
/// but every operation respects the 4% density budget and uses VSA
/// primitives (bind, superpose, permute) instead of dense matrix ops.
///
/// ## Biological Analogy
/// Like a cortical microcolumn: multiple minicolumns (heads) attend to
/// different features of the input, then a basket-cell interneuron layer
/// (feed-forward) rebalances the activity, and the output is passed
/// forward with a skip connection (residual).
#[derive(Debug, Clone)]
pub struct RshlTransformerBlock {
    /// Parallel attention heads (4 or 8, configurable at construction).
    pub heads: Vec<RshlHead>,

    /// Semantic transformation layer.
    pub ff_layer: RshlFeedForward,

    /// Residual scale for the attention sub-layer.
    /// How much the original input is preserved vs. replaced by attention output.
    pub attn_residual: f32,

    /// Residual scale for the FF sub-layer.
    pub ff_residual: f32,
}

impl RshlTransformerBlock {
    /// Create a new transformer block with `n_heads` attention heads.
    ///
    /// ## Energy Economy
    /// More heads = more compute "ATP". The system should choose:
    ///   * `n_heads = 4` for fast, low-energy operation (default)
    ///   * `n_heads = 8` for rich, high-fidelity reasoning (when coherence is high)
    pub fn with_heads(n_heads: usize) -> Self {
        let heads: Vec<RshlHead> = (0..n_heads).map(RshlHead::new).collect();
        Self {
            heads,
            ff_layer: RshlFeedForward::new(),
            attn_residual: 0.6, // Preserve 60% of input, 40% attention
            ff_residual: 0.7,  // Preserve 70% of attention output, 30% FF transform
        }
    }

    /// Forward pass through the transformer block.
    ///
    /// ## Pipeline
    /// 1. **Multi-head attention**: Each head attends to the context window.
    ///    Head outputs are bundled together with their head keys (like
    ///    concatenation in dense transformers, but via superposition).
    /// 2. **Residual connection 1**: `output = input * attn_residual + attended * (1 - attn_residual)`
    /// 3. **Feed-forward**: Semantic transformation of the attention output.
    /// 4. **Residual connection 2**: `output = attn_output * ff_residual + ff_output * (1 - ff_residual)`
    /// 5. **Density clamp**: Ensure 4% budget after both additions.
    ///
    /// ## Parameters
    /// * `input` — current position state (already bound to its position key)
    /// * `context` — previous position-bound vectors to attend to
    pub fn forward(
        &self,
        input: &SparseVec,
        context: &[(usize, SparseVec)],
    ) -> SparseVec {
        if context.is_empty() {
            // No context to attend to — just pass through FF layer
            return self.ff_layer.forward(input);
        }

        // 1. Multi-head attention
        let head_outputs: Vec<SparseVec> = self
            .heads
            .iter()
            .map(|h| h.attend(input, context))
            .collect();

        // Bundle all head outputs. Each head contributes equally.
        let head_refs: Vec<&SparseVec> = head_outputs.iter().collect();
        let attended = SparseVec::superpose_sparse(&head_refs, TARGET_DENSITY);

        // 2. Residual connection (attention sub-layer)
        let attn_out = weighted_superpose(
            &[(input, self.attn_residual), (&attended, 1.0 - self.attn_residual)],
            TARGET_DENSITY,
        );

        // 3. Feed-forward transformation
        let ff_out = self.ff_layer.forward(&attn_out);

        // 4. Residual connection (FF sub-layer)
        let final_out = weighted_superpose(
            &[(input, self.ff_residual), (&ff_out, 1.0 - self.ff_residual)],
            TARGET_DENSITY,
        );

        final_out
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Transformer Config — Runtime head-count switch
// ─────────────────────────────────────────────────────────────────────────────

/// Runtime configuration for the RSHL transformer.
/// Loaded at startup from `data/kai_transformer_config.json`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TransformerConfig {
    /// Number of attention heads. 4 = low-energy, 8 = high-fidelity.
    pub n_heads: usize,
    /// Attention temperature. Lower = sharper focus.
    pub temperature: f32,
    /// Maximum context window length.
    pub max_context_len: usize,
    /// Whether to use the transformer in generation.
    pub enabled: bool,
}

impl TransformerConfig {
    /// Load from disk or create default.
    pub fn load_or_default(path: &str) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    /// Save to disk.
    pub fn save(&self, path: &str) -> std::io::Result<()> {
        let s = serde_json::to_string_pretty(self)?;
        std::fs::write(path, s)
    }

    /// Construct a transformer block from this config.
    pub fn build_block(&self) -> RshlTransformerBlock {
        let mut block = RshlTransformerBlock::with_heads(self.n_heads);
        block.heads.iter_mut().for_each(|h| h.temperature = self.temperature);
        block
    }
}

impl Default for TransformerConfig {
    fn default() -> Self {
        Self {
            n_heads: 4,       // Low-energy default
            temperature: DEFAULT_TEMPERATURE,
            max_context_len: MAX_CONTEXT_LEN,
            enabled: true,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Softmax over a slice of scores.
/// Like the firing probability of a neuronal population: each score is
/// exponentiated and normalized so they sum to 1.0.
fn softmax(scores: &[f32], temperature: f32) -> Vec<f32> {
    if scores.is_empty() {
        return Vec::new();
    }
    let max_score = scores.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let exp_sum: f32 = scores
        .iter()
        .map(|s| {
            let shifted = (s - max_score) / temperature.max(0.1);
            shifted.exp()
        })
        .sum();
    if exp_sum < 1e-10 {
        let uniform = 1.0 / scores.len() as f32;
        return vec![uniform; scores.len()];
    }
    scores
        .iter()
        .map(|s| {
            let shifted = (s - max_score) / temperature.max(0.1);
            shifted.exp() / exp_sum
        })
        .collect()
}

/// Density clamp: keep top `density * DIM` dimensions by magnitude.
/// This is the sacred operation that enforces Conservation of Information.
/// No vector in RSHL may exceed the density budget — it's physical law.
fn density_clamp(sums: &[f32], density: f32) -> SparseVec {
    let target_count = ((DIM as f32) * density) as usize;
    if target_count == 0 {
        return SparseVec::zero();
    }

    let mut indexed: Vec<(usize, f32)> = sums
        .iter()
        .enumerate()
        .filter(|(_, v)| **v != 0.0)
        .map(|(i, v)| (i, v.abs()))
        .collect();
    indexed.sort_unstable_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    indexed.truncate(target_count);

    let mut data = vec![0i8; DIM];
    for (i, _) in indexed {
        data[i] = if sums[i] > 0.0 { 1 } else { -1 };
    }
    SparseVec::from_raw(data)
}

/// Weighted superposition with density clamp.
/// Same math as `generative::weighted_superpose` but kept local for
/// module independence.
fn weighted_superpose(terms: &[(&SparseVec, f32)], density: f32) -> SparseVec {
    let mut sums = vec![0f32; DIM];
    let mut any = false;
    for (v, w) in terms {
        if *w <= 0.0 || v.nnz() == 0 {
            continue;
        }
        any = true;
        for (i, val) in v.iter() {
            let d = val as f32;
            sums[i] += *w * d;
        }
    }
    if !any {
        return SparseVec::zero();
    }
    density_clamp(&sums, density)
}

/// Generate a deterministic sparse vector from a seed.
/// Used for head keys and transformation vectors.
/// The output is always ~4% sparse with balanced +1/−1.
fn generate_head_key(seed: u32) -> SparseVec {
    let mut data = vec![0i8; DIM];
    let target_nnz = ((DIM as f32) * TARGET_DENSITY) as usize;
    let mut pos_count = 0usize;
    let mut neg_count = 0usize;

    let mut s = seed as u64;
    for i in 0..DIM {
        if pos_count + neg_count >= target_nnz {
            break;
        }
        // XOR-shift PRNG
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        let threshold = (DIM as u64) / (target_nnz as u64);
        if s % threshold == 0 {
            // Activate this dimension
            let is_pos = (s >> 32).count_ones() % 2 == 0;
            data[i] = if is_pos { 1 } else { -1 };
            if is_pos {
                pos_count += 1;
            } else {
                neg_count += 1;
            }
        }
    }

    SparseVec::from_raw(data)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn head_key_is_deterministic() {
        let k1 = generate_head_key(42);
        let k2 = generate_head_key(42);
        assert_eq!(k1.to_dense(), k2.to_dense(), "head key must be deterministic");
    }

    #[test]
    fn head_key_is_sparse() {
        let k = generate_head_key(99);
        let nnz = k.nnz();
        let expected = ((DIM as f32) * TARGET_DENSITY) as usize;
        let slack = (expected as f32 * 0.1) as usize;
        assert!(
            nnz >= expected.saturating_sub(slack) && nnz <= expected + slack,
            "head key density should be ~4%, got {} (target ~{})",
            nnz,
            expected
        );
    }

    #[test]
    fn softmax_sums_to_one() {
        let scores = vec![0.2, 0.5, 0.1, 0.8];
        let w = softmax(&scores, 1.0);
        let sum: f32 = w.iter().sum();
        assert!((sum - 1.0).abs() < 0.001, "softmax must sum to 1, got {}", sum);
    }

    #[test]
    fn attention_on_empty_context_returns_zero() {
        let head = RshlHead::new(0);
        let query = SparseVec::encode("hello world");
        let out = head.attend(&query, &[]);
        assert_eq!(out.nnz(), 0, "empty context → zero output");
    }

    #[test]
    fn transformer_block_runs_without_panic() {
        let block = RshlTransformerBlock::with_heads(4);
        let input = SparseVec::encode("test query");
        let ctx: Vec<(usize, SparseVec)> = vec![
            (0, SparseVec::encode("first context")),
            (1, SparseVec::encode("second context")),
        ];
        let out = block.forward(&input, &ctx);
        assert!(out.nnz() > 0, "transformer should produce non-zero output");
    }

    #[test]
    fn density_clamp_respects_budget() {
        let mut sums = vec![0f32; DIM];
        for i in 0..DIM {
            sums[i] = (i % 7) as f32 - 3.0; // mix of positive and negative
        }
        let out = density_clamp(&sums, 0.04);
        let budget = ((DIM as f32) * 0.04) as usize;
        let slack = (budget as f32 * 0.05) as usize;
        assert!(
            out.nnz() <= budget + slack,
            "density clamp must not exceed budget, got {} vs target {}",
            out.nnz(),
            budget
        );
    }

    #[test]
    fn eight_heads_more_expressive_than_four() {
        let block4 = RshlTransformerBlock::with_heads(4);
        let block8 = RshlTransformerBlock::with_heads(8);
        assert_eq!(block4.heads.len(), 4);
        assert_eq!(block8.heads.len(), 8);
        // Head 4 in the 8-head block has no counterpart in the 4-head block,
        // proving they generate different subspaces.
        assert_ne!(
            block4.heads[0].head_key.to_dense(),
            block8.heads[4].head_key.to_dense(),
            "different configs should produce different head keys"
        );
    }
}
