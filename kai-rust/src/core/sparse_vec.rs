/// RSHL Sparse Ternary Vector Engine
///
/// 4096-dimensional sparse ternary vectors: each dimension is -1, 0, or +1.
/// Encoding uses BOTH character trigrams AND word-level hashing.
/// This dual encoding lets "what is your name" match "my name is KAI"
/// because the word "name" creates identical hash patterns in both.
///
/// This is the mathematical core of KAI's memory.

const DIM: usize = 4096;
const SPARSITY: f32 = 0.04; // 4% non-zero per feature

/// A sparse ternary vector in 4096 dimensions.
/// Values are -1, 0, or +1 stored as i8 for cache efficiency.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct SparseVec {
    pub data: Vec<i8>,
}

impl SparseVec {
    /// Create a zero vector.
    pub fn zero() -> Self {
        Self { data: vec![0i8; DIM] }
    }

    /// Create from raw data (for inter-stream communication).
    pub fn from_raw(data: Vec<i8>) -> Self {
        assert_eq!(data.len(), DIM);
        Self { data }
    }

    /// Encode a text string into a sparse ternary vector.
    /// Uses three layers of features for robust semantic matching:
    ///   1. Character trigrams (local shape — raw text, not normalized)
    ///   2. Normalized words (semantic content — stopwords removed, synonyms collapsed, stemmed, category anchors injected)
    ///   3. Normalized word bigrams (contextual pairs)
    pub fn encode(text: &str) -> Self {
        let mut v = vec![0i32; DIM];
        let lower = text.to_lowercase();
        let chars: Vec<char> = lower.chars().collect();

        // ── Layer 1: Character trigrams (weighted 1x) ────────────────────
        // Uses RAW text for surface-level pattern matching.
        if chars.len() >= 3 {
            for i in 0..chars.len().saturating_sub(2) {
                let tri = &chars[i..i + 3];
                let base = hash_trigram(tri);
                let n_active = 12; // Fixed bits per feature to avoid saturation
                for k in 0..n_active {
                    let idx = (base.wrapping_add(k * 2654435761)) % DIM;
                    let sign = if (base.wrapping_add(k * 1442695040)) % 2 == 0 { 1 } else { -1 };
                    let rotated = (idx + i * 97) % DIM;
                    v[rotated] += sign;
                }
            }
        } else {
            for (i, &ch) in chars.iter().enumerate() {
                let h = hash_char(ch, i);
                let idx = h % DIM;
                v[idx] += if (h / DIM) % 2 == 0 { 1 } else { -1 };
            }
        }

        // ── Layer 2: NORMALIZED word-level hashing (weighted 3x — the semantic layer)
        // Uses the full normalization pipeline: stopwords → synonyms → stemming → category anchors.
        // This is what makes "occupation" encode the same as "job" and injects #job.
        let normalizer = super::normalize::get_normalizer();
        let normalized_tokens = normalizer.normalize_text(text);

        // ── Proper noun detection — names and entities get boosted weight (6x vs 3x) ──
        // A sentence like "well what is your name? im Ryan Nice to meet you" should have
        // "ryan" dominate the vector — not be drowned out by filler words.
        // Detection rules:
        //   1. Known core entities always boost (ryan, kai, rshl)
        //   2. Capitalized words at non-sentence-start positions (mid-sentence proper nouns)
        //   3. ALL-CAPS tokens (acronyms: RSHL, AI, DNA, etc.)
        let known_entities: &[&str] = &["ryan", "kai", "rshl", "kaii"];
        let original_words: Vec<&str> = text.split_whitespace().collect();
        let proper_nouns: std::collections::HashSet<String> = {
            let mut set = std::collections::HashSet::new();
            for (i, word) in original_words.iter().enumerate() {
                let clean: String = word.chars().filter(|c| c.is_alphabetic()).collect();
                if clean.len() < 2 { continue; }
                let lower_clean = clean.to_lowercase();
                // Always boost known core entities regardless of position
                if known_entities.contains(&lower_clean.as_str()) {
                    set.insert(lower_clean.clone());
                    continue;
                }
                // Capitalized mid-sentence = proper noun (position > 0, not just sentence-start caps)
                let first_upper = clean.chars().next().map(|c| c.is_uppercase()).unwrap_or(false);
                if i > 0 && first_upper {
                    set.insert(lower_clean.clone());
                }
                // ALL-CAPS tokens (acronyms) — always a proper noun signal
                if clean.chars().all(|c| c.is_uppercase()) {
                    set.insert(lower_clean);
                }
            }
            set
        };

        for token in &normalized_tokens {
            let base = hash_word(token);
            let n_active = 12;
            // Proper nouns get 6x weight — names and entities are the most semantically
            // discriminative words. "Ryan" in a sentence matters far more than "nice" or "meet".
            let word_weight: i32 = if proper_nouns.contains(token.as_str()) { 6 } else { 3 };
            for k in 0..n_active {
                let idx = (base.wrapping_add(k * 2654435761)) % DIM;
                let sign = if (base.wrapping_add(k * 1442695040)) % 2 == 0 { word_weight } else { -word_weight };
                v[idx] += sign;
            }
        }

        if normalized_tokens.len() >= 2 {
            for i in 0..normalized_tokens.len() - 1 {
                let w1 = &normalized_tokens[i];
                let w2 = &normalized_tokens[i + 1];
                // Skip category anchors in bigrams (they're cluster signals, not word pairs)
                if w1.starts_with('#') || w2.starts_with('#') { continue; }

                let base = hash_word_pair(w1, w2);
                let n_active = 8; // Slightly fewer bits for bigrams (supporting signal)
                for k in 0..n_active {
                    let idx = (base.wrapping_add(k * 2654435761)) % DIM;
                    let sign = if (base.wrapping_add(k * 1442695040)) % 2 == 0 { 2 } else { -2 };
                    v[idx] += sign; // 2x weight for word bigrams
                }
            }
        }

        // Ternary threshold + Sparsification: keep only top 4% magnitudes
        let target_count = ((DIM as f32) * SPARSITY) as usize;
        let mut magnitudes: Vec<i32> = v.iter().map(|s| s.abs()).collect();
        magnitudes.sort_unstable_by(|a, b| b.cmp(a));
        let threshold = if target_count < DIM { magnitudes[target_count] } else { 0 };

        let mut data = vec![0i8; DIM];
        for i in 0..DIM {
            let val = v[i];
            if (threshold > 0 && val.abs() >= threshold) || (threshold == 0 && val != 0) {
                data[i] = if val > 0 { 1 } else { -1 };
            }
        }

        Self { data }
    }

    /// Encode text with spelling correction via the Lexicon.
    ///
    /// Before encoding into the 4096-dimensional space, each word token
    /// is checked against KAI's vocabulary. Unknown words within edit
    /// distance ≤ 2 of a known word are corrected to the known form.
    ///
    /// This means "wrold" encodes identically to "world" — the
    /// misspelling is pulled to the nearest known attractor in word-space.
    ///
    /// Returns (vector, corrections) where corrections lists what was fixed.
    pub fn encode_corrected(text: &str, lexicon: &super::lexicon::Lexicon) -> (Self, Vec<(String, String)>) {
        let (corrected_text, corrections) = lexicon.correct_sentence(text);
        let vec = Self::encode(&corrected_text);
        (vec, corrections)
    }

    /// Cosine similarity between two vectors. Returns [-1.0, +1.0].
    pub fn cosine(&self, other: &SparseVec) -> f32 {
        let (a, b) = (&self.data, &other.data);
        let mut dot: i32 = 0;
        let mut mag_a: i32 = 0;
        let mut mag_b: i32 = 0;

        let chunks = DIM / 8;
        for chunk in 0..chunks {
            let base = chunk * 8;
            let mut d = 0i32;
            let mut ma = 0i32;
            let mut mb = 0i32;
            for j in 0..8 {
                let ai = a[base + j] as i32;
                let bi = b[base + j] as i32;
                d += ai * bi;
                ma += ai * ai;
                mb += bi * bi;
            }
            dot += d;
            mag_a += ma;
            mag_b += mb;
        }

        for i in (chunks * 8)..DIM {
            let ai = a[i] as i32;
            let bi = b[i] as i32;
            dot += ai * bi;
            mag_a += ai * ai;
            mag_b += bi * bi;
        }

        if mag_a == 0 || mag_b == 0 {
            return 0.0;
        }

        dot as f32 / ((mag_a as f32).sqrt() * (mag_b as f32).sqrt())
    }

    /// Bundle (superpose) multiple vectors.
    pub fn bundle(vecs: &[&SparseVec]) -> Self {
        if vecs.is_empty() {
            return Self::zero();
        }
        let mut acc = vec![0i32; DIM];
        for v in vecs {
            for i in 0..DIM {
                acc[i] += v.data[i] as i32;
            }
        }
        let threshold = (vecs.len() as i32 + 1) / 2;
        let mut data = vec![0i8; DIM];
        for i in 0..DIM {
            data[i] = if acc[i] >= threshold {
                1
            } else if acc[i] <= -threshold {
                -1
            } else {
                0
            };
        }
        Self { data }
    }

    /// Superpose without consensus threshold, but with a sparsity target.
    /// Each position takes the sign of the net signed sum across all vectors.
    /// Use for building active-state vectors.
    pub fn superpose_sparse(vecs: &[&SparseVec], target_density: f32) -> Self {
        let mut sums = [0i32; DIM];
        for v in vecs {
            for i in 0..DIM {
                sums[i] += v.data[i] as i32;
            }
        }
        
        let target_count = ((DIM as f32) * target_density) as usize;
        let mut magnitudes: Vec<i32> = sums.iter().map(|s| s.abs()).collect();
        magnitudes.sort_unstable_by(|a, b| b.cmp(a));
        let threshold = if target_count < DIM { magnitudes[target_count] } else { 0 };
        
        let mut out = SparseVec::zero();
        for i in 0..DIM {
            if sums[i].abs() > threshold {
                out.data[i] = sums[i].signum() as i8;
            }
        }
        out
    }

    /// Bind two vectors (element-wise multiply).
    pub fn bind(&self, other: &SparseVec) -> Self {
        let mut data = vec![0i8; DIM];
        for i in 0..DIM {
            data[i] = self.data[i] * other.data[i];
        }
        Self { data }
    }

    /// Count non-zero elements.
    pub fn nnz(&self) -> usize {
        self.data.iter().filter(|&&x| x != 0).count()
    }

    /// Magnitude (L2 norm).
    pub fn magnitude(&self) -> f32 {
        (self.nnz() as f32).sqrt()
    }
}

/// Hash a single character with position.
fn hash_char(ch: char, pos: usize) -> usize {
    let mut h = ch as usize;
    h = h.wrapping_mul(2654435761);
    h ^= pos.wrapping_mul(1442695040);
    h = h.wrapping_mul(0x9e3779b9);
    h
}

/// Hash a character trigram.
fn hash_trigram(tri: &[char]) -> usize {
    let mut h: usize = 0;
    for (i, &ch) in tri.iter().enumerate() {
        h = h.wrapping_mul(31).wrapping_add(ch as usize);
        h ^= (i + 1).wrapping_mul(2654435761);
    }
    h = h.wrapping_mul(0x9e3779b9);
    h % (usize::MAX / 2)
}

/// Hash a single word (position-independent for semantic matching).
fn hash_word(word: &str) -> usize {
    let mut h: usize = 5381;
    for b in word.bytes() {
        h = h.wrapping_mul(33).wrapping_add(b as usize);
    }
    h = h.wrapping_mul(0x9e3779b9);
    h % (usize::MAX / 2)
}

/// Hash a pair of words (order-sensitive for context).
fn hash_word_pair(w1: &str, w2: &str) -> usize {
    let h1 = hash_word(w1);
    let h2 = hash_word(w2);
    let combined = h1.wrapping_mul(31).wrapping_add(h2);
    combined.wrapping_mul(0x9e3779b9) % (usize::MAX / 2)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encode_produces_sparse_vec() {
        let v = SparseVec::encode("hello world");
        assert_eq!(v.data.len(), DIM);
        let nnz = v.nnz();
        assert!(nnz > 0 && nnz < DIM / 2, "nnz={} should be sparse", nnz);
    }

    #[test]
    fn test_self_similarity_is_one() {
        let v = SparseVec::encode("test string");
        let sim = v.cosine(&v);
        assert!((sim - 1.0).abs() < 0.001, "self-similarity={}", sim);
    }

    #[test]
    fn test_similar_texts_high_cosine() {
        let a = SparseVec::encode("the cat sat on the mat");
        let b = SparseVec::encode("the cat sat on a mat");
        let sim = a.cosine(&b);
        assert!(sim > 0.5, "similar texts should have high cosine: {}", sim);
    }

    #[test]
    fn test_different_texts_low_cosine() {
        let a = SparseVec::encode("quantum physics equations");
        let b = SparseVec::encode("chocolate cake recipe");
        let sim = a.cosine(&b);
        assert!(sim < 0.3, "different texts should have low cosine: {}", sim);
    }

    #[test]
    fn test_word_semantic_matching() {
        // With normalization, "where does Ryan live" and "Ryan's city"
        // should both contain tokens [ryan, live, #loc] — high overlap
        let query = SparseVec::encode("where does Ryan live");
        let answer = SparseVec::encode("Ryan's city is Austin");
        let unrelated = SparseVec::encode("quantum physics equations");
        let sim_match = query.cosine(&answer);
        let sim_unrelated = query.cosine(&unrelated);
        assert!(sim_match > sim_unrelated,
            "location query should match location answer ({:.4}) more than unrelated ({:.4})",
            sim_match, sim_unrelated);
    }

    #[test]
    fn test_synonym_equivalence() {
        // "occupation" and "job" should both normalize to "work" + "#job"
        let a = SparseVec::encode("Ryan's occupation");
        let b = SparseVec::encode("Ryan's job");
        let sim = a.cosine(&b);
        assert!(sim > 0.5,
            "synonym-equivalent phrases should have high similarity: {:.4}", sim);
    }

    #[test]
    fn test_bundle_preserves_majority() {
        // Bundle of overlapping vecs should be closer to each input than random
        let a = SparseVec::encode("mathematics algebra geometry");
        let b = SparseVec::encode("mathematics calculus topology");
        let c = SparseVec::encode("mathematics number theory");
        let bundle = SparseVec::bundle(&[&a, &b, &c]);
        let query  = SparseVec::encode("mathematics");
        let random = SparseVec::encode("purple elephant jazz");
        assert!(bundle.cosine(&query) > bundle.cosine(&random),
            "bundle should be closer to shared concept than random noise");
    }
}

// ── (end of sparse_vec.rs) ──
        // Use highly overlapping strings t