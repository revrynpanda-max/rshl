/// Resonance Attention — KAI's geometric self-attention.
///
/// In LLMs, self-attention lets each token "attend to" every other
/// token with learned weights. In RSHL, we do the geometric equivalent:
///
/// Each query token gets weighted by how strongly it resonates with
/// the universe. Important words (that match many cells) get amplified.
/// Noise words (that match nothing) get suppressed.
///
/// This replaces equal-weight bundling with intelligent weighting:
///   Before: query = hash(word1) + hash(word2) + hash(word3)
///   After:  query = 3.2·hash(sky) + 2.1·hash(night) + 0.1·hash(the)
///
/// The weights come from the universe itself — no training needed.

use crate::core::SparseVec;

const DIM: usize = 4096;
const MIN_ATTENTION: f32 = 0.1; // Floor — every token gets at least this weight

/// Compute resonance attention weights for a set of tokens.
/// 
/// For each token, quickly scan the cell vectors to see how many
/// cells resonate with it. Tokens that match many cells get higher weight.
///
/// Returns: Vec of (token_index, weight) where weights sum to 1.0
pub fn compute_attention_weights(
    token_vecs: &[SparseVec],
    cell_vecs: &[&SparseVec],
) -> Vec<f32> {
    if token_vecs.is_empty() {
        return Vec::new();
    }

    let mut raw_weights: Vec<f32> = Vec::with_capacity(token_vecs.len());

    for token_vec in token_vecs {
        // Count how many cells this token resonates with + avg similarity
        let mut hit_count = 0usize;
        let mut sim_sum = 0.0f32;

        // Sample up to 200 cells for speed (random stride if more)
        let stride = if cell_vecs.len() > 200 {
            cell_vecs.len() / 200
        } else {
            1
        };

        let mut i = 0;
        while i < cell_vecs.len() {
            let sim = token_vec.cosine(cell_vecs[i]);
            if sim > 0.15 {
                hit_count += 1;
                sim_sum += sim;
            }
            i += stride;
        }

        // Weight = log(1 + hits) × avg_similarity
        let avg_sim = if hit_count > 0 {
            sim_sum / hit_count as f32
        } else {
            0.0
        };
        let weight = (1.0 + hit_count as f32).ln() * (avg_sim + MIN_ATTENTION);
        raw_weights.push(weight.max(MIN_ATTENTION));
    }

    // Normalize to sum = 1.0
    let total: f32 = raw_weights.iter().sum();
    if total <= 0.0 {
        // Equal weights fallback
        let uniform = 1.0 / token_vecs.len() as f32;
        return vec![uniform; token_vecs.len()];
    }

    raw_weights.iter().map(|w| w / total).collect()
}

/// Build an attention-weighted query vector from tokens.
///
/// Instead of bundling all tokens equally, each token's hash vector
/// is weighted by its resonance with the universe.
pub fn build_attended_query(
    tokens: &[String],
    cell_vecs: &[&SparseVec],
) -> SparseVec {
    if tokens.is_empty() {
        return SparseVec::encode("");
    }

    // Encode each token individually
    let token_vecs: Vec<SparseVec> = tokens
        .iter()
        .map(|t| SparseVec::encode(t))
        .collect();

    // Compute attention weights
    let weights = compute_attention_weights(&token_vecs, cell_vecs);

    // Weighted superposition
    let mut combined = vec![0.0f32; DIM];
    for (vec, weight) in token_vecs.iter().zip(weights.iter()) {
        for d in 0..DIM {
            combined[d] += vec.data[d] as f32 * weight;
        }
    }

    // Ternary quantize
    // Adaptive threshold: based on the mean absolute value
    let abs_mean: f32 = combined.iter().map(|v| v.abs()).sum::<f32>() / DIM as f32;
    let threshold = (abs_mean * 1.5).max(0.05);

    let data: Vec<i8> = combined
        .iter()
        .map(|&v| {
            if v > threshold { 1i8 }
            else if v < -threshold { -1i8 }
            else { 0i8 }
        })
        .collect();

    SparseVec::from_raw(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_uniform_attention_on_empty_universe() {
        let vecs = vec![
            SparseVec::encode("hello"),
            SparseVec::encode("world"),
        ];
        let weights = compute_attention_weights(&vecs, &[]);
        assert_eq!(weights.len(), 2);
        // With no cells, should get equal weights
        assert!((weights[0] - weights[1]).abs() < 0.3,
            "Should be roughly equal: {:?}", weights);
    }

    #[test]
    fn test_attended_query_produces_valid_vec() {
        let tokens = vec!["sky".to_string(), "blue".to_string(), "color".to_string()];
        let result = build_attended_query(&tokens, &[]);
        // Should produce a non-zero vector
        let nonzero: usize = result.data.iter().filter(|&&v| v != 0).count();
        assert!(nonzero > 50, "Attended query should produce meaningful vector, got {} nonzero", nonzero);
    }

    #[test]
    fn test_attention_amplifies_relevant_tokens() {
        // Create a small "universe" that knows about sky
        let sky_cell = SparseVec::encode("sky atmosphere clouds blue");
        let cell_refs: Vec<&SparseVec> = vec![&sky_cell];

        let token_vecs = vec![
            SparseVec::encode("sky"),
            SparseVec::encode("xyzzy"), // nonsense word
        ];

        let weights = compute_attention_weights(&token_vecs, &cell_refs);
        assert!(weights[0] >= weights[1],
            "Sky should get at least as much weight as nonsense: {:?}", weights);
    }
}
