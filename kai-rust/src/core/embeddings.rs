use crate::core::SparseVec;
/// Co-occurrence Embeddings — KAI learns word relationships from his own universe.
///
/// This is the RSHL equivalent of Word2Vec / learned embeddings.
/// Instead of training on billions of sentences, KAI scans his own
/// universe cells and discovers which words appear together.
///
/// Words that co-occur in the same cells develop shared geometric
/// signatures — "dog" and "puppy" end up near each other because
/// they appear in similar contexts within KAI's memory.
///
/// The learned vectors are blended with hash vectors:
///   final_vec = (1-α) * hash_vec + α * learned_vec
///   where α = 0.35 (tunable)
use std::collections::HashMap;

const DIM: usize = 4096;
const LEARN_BLEND: f32 = 0.35; // How much learned embeddings influence the final vector
const MIN_COOCCURRENCE: usize = 2; // Minimum co-occurrences to create a learned vector
const MAX_VOCAB: usize = 5000; // Max words to track

/// Learned word embeddings from universe co-occurrence patterns.
pub struct Embeddings {
    /// word → learned sparse ternary vector
    pub vectors: HashMap<String, Vec<i8>>,
    /// How many cells were scanned to produce these embeddings
    pub cells_scanned: usize,
    /// Number of unique words with learned vectors
    pub vocab_size: usize,
}

impl Embeddings {
    pub fn new() -> Self {
        Self {
            vectors: HashMap::new(),
            cells_scanned: 0,
            vocab_size: 0,
        }
    }

    /// Learn word embeddings from universe cell co-occurrence.
    ///
    /// Algorithm:
    /// 1. For each cell, extract normalized words
    /// 2. Build co-occurrence counts: word_a appears with word_b
    /// 3. For each word, build a "context vector" by superimposing
    ///    the hash vectors of all words it co-occurs with, weighted
    ///    by co-occurrence frequency
    /// 4. This context vector IS the learned embedding
    pub fn learn_from_cells(&mut self, cells: &[(String, Vec<String>)]) {
        // Step 1: Build co-occurrence matrix
        let mut cooccur: HashMap<String, HashMap<String, usize>> = HashMap::new();
        let mut word_freq: HashMap<String, usize> = HashMap::new();

        for (_text, tokens) in cells {
            // Count word frequency
            for tok in tokens {
                *word_freq.entry(tok.clone()).or_insert(0) += 1;
            }

            // Count co-occurrences (all pairs within the same cell)
            for i in 0..tokens.len() {
                for j in (i + 1)..tokens.len() {
                    if tokens[i] != tokens[j] {
                        *cooccur
                            .entry(tokens[i].clone())
                            .or_default()
                            .entry(tokens[j].clone())
                            .or_insert(0) += 1;
                        *cooccur
                            .entry(tokens[j].clone())
                            .or_default()
                            .entry(tokens[i].clone())
                            .or_insert(0) += 1;
                    }
                }
            }
        }

        // Step 2: Build learned vectors from co-occurrence
        let mut new_vectors: HashMap<String, Vec<i8>> = HashMap::new();

        // Only process the most frequent words (cap at MAX_VOCAB)
        let mut freq_list: Vec<(&String, &usize)> = word_freq.iter().collect();
        freq_list.sort_by(|a, b| b.1.cmp(a.1));
        freq_list.truncate(MAX_VOCAB);

        let top_words: Vec<String> = freq_list.iter().map(|(w, _)| (*w).clone()).collect();

        for word in &top_words {
            if let Some(neighbors) = cooccur.get(word) {
                // Filter to significant co-occurrences
                let sig_neighbors: Vec<(&String, &usize)> = neighbors
                    .iter()
                    .filter(|(_, count)| **count >= MIN_COOCCURRENCE)
                    .collect();

                if sig_neighbors.is_empty() {
                    continue;
                }

                // Build context vector: weighted superposition of neighbor hash vectors
                let mut context = vec![0i32; DIM];
                let mut total_weight = 0.0f32;

                for (neighbor, count) in &sig_neighbors {
                    let weight = (**count as f32).sqrt(); // sqrt to prevent dominant neighbors
                    let neighbor_hash = SparseVec::encode(neighbor);

                    for d in 0..DIM {
                        context[d] += (neighbor_hash.data[d] as f32 * weight) as i32;
                    }
                    total_weight += weight;
                }

                if total_weight < 1.0 {
                    continue;
                }

                // Ternary quantize the context vector
                let threshold = (total_weight * 0.3) as i32; // ~30% of max weight
                let learned: Vec<i8> = context
                    .iter()
                    .map(|&v| {
                        if v > threshold {
                            1i8
                        } else if v < -threshold {
                            -1i8
                        } else {
                            0i8
                        }
                    })
                    .collect();

                // Only store if the learned vector is meaningfully different from zero
                let nonzero: usize = learned.iter().filter(|&&v| v != 0).count();
                if nonzero > 20 {
                    new_vectors.insert(word.clone(), learned);
                }
            }
        }

        self.vectors = new_vectors;
        self.cells_scanned = cells.len();
        self.vocab_size = self.vectors.len();
    }

    /// Blend a hash-encoded vector with learned embeddings.
    /// Returns the blended vector if learned data exists for any token.
    pub fn blend(&self, hash_vec: &SparseVec, tokens: &[String]) -> SparseVec {
        if self.vectors.is_empty() {
            return hash_vec.clone();
        }

        // Check if any tokens have learned vectors
        let learned_tokens: Vec<&Vec<i8>> =
            tokens.iter().filter_map(|t| self.vectors.get(t)).collect();

        if learned_tokens.is_empty() {
            return hash_vec.clone();
        }

        // Build learned component: average of all matching learned vectors
        let mut learned_sum = vec![0i32; DIM];
        for vec in &learned_tokens {
            for d in 0..DIM {
                learned_sum[d] += vec[d] as i32;
            }
        }

        // Blend: (1-α) * hash + α * learned
        let alpha = LEARN_BLEND;
        let hash_weight = 1.0 - alpha;
        let learn_weight = alpha / learned_tokens.len() as f32;

        let mut blended = vec![0i8; DIM];
        for d in 0..DIM {
            let h = hash_vec.data[d] as f32 * hash_weight;
            let l = learned_sum[d] as f32 * learn_weight;
            let combined = h + l;

            blended[d] = if combined > 0.3 {
                1i8
            } else if combined < -0.3 {
                -1i8
            } else {
                0i8
            };
        }

        SparseVec::from_raw(blended)
    }

    /// Check if embeddings need rebuilding (called after cell count changes).
    pub fn needs_rebuild(&self, current_cell_count: usize) -> bool {
        if self.cells_scanned == 0 && current_cell_count >= 30 {
            return true; // First build
        }
        // Rebuild every 200 new cells
        current_cell_count > self.cells_scanned + 200
    }
}

impl Default for Embeddings {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cooccurrence_learning() {
        let mut emb = Embeddings::new();

        // Simulate cells where "dog" and "puppy" co-occur
        let cells = vec![
            (
                "dogs are loyal pets".into(),
                vec!["dog".into(), "loyal".into(), "pet".into()],
            ),
            (
                "puppies are young dogs".into(),
                vec!["puppy".into(), "young".into(), "dog".into()],
            ),
            (
                "my puppy is cute".into(),
                vec!["puppy".into(), "cute".into()],
            ),
            (
                "dogs and puppies play".into(),
                vec!["dog".into(), "puppy".into(), "play".into()],
            ),
            (
                "loyal dogs guard homes".into(),
                vec!["loyal".into(), "dog".into(), "guard".into()],
            ),
        ];

        emb.learn_from_cells(&cells);
        assert!(emb.vocab_size > 0, "Should have learned some vectors");
    }

    #[test]
    fn test_needs_rebuild() {
        let emb = Embeddings::new();
        assert!(!emb.needs_rebuild(10)); // too few cells
        assert!(emb.needs_rebuild(30)); // first build threshold
    }

    #[test]
    fn test_blend_no_learned() {
        let emb = Embeddings::new();
        let hash = SparseVec::encode("hello world");
        let blended = emb.blend(&hash, &["hello".into(), "world".into()]);
        // With no learned vectors, blend should return hash unchanged
        assert!(
            (hash.cosine(&blended) - 1.0).abs() < 0.001,
            "Should be ~1.0, got {}",
            hash.cosine(&blended)
        );
    }
}
