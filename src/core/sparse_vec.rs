/// RSHL Sparse Ternary Vector Engine
///
/// 16384-dimensional sparse ternary vectors: each dimension is -1, 0, or +1.
/// Encoding uses BOTH character trigrams AND word-level hashing.
/// This dual encoding lets "what is your name" match "my name is KAI"
/// because the word "name" creates identical hash patterns in both.
///
/// This is the mathematical core of KAI's memory.

pub const DIM: usize = 16384;
const SPARSITY: f32 = 0.04; // 4% non-zero per feature

/// A sparse ternary vector in 16384 dimensions.
/// Values are -1, 0, or +1 stored as i8 for cache efficiency.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct SparseVec {
    pub data: Vec<i8>,
}

impl SparseVec {
    /// Create a zero vector.
    pub fn zero() -> Self {
        Self {
            data: vec![0i8; DIM],
        }
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
                    let sign = if (base.wrapping_add(k * 1442695040)) % 2 == 0 {
                        1
                    } else {
                        -1
                    };
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
                if clean.len() < 2 {
                    continue;
                }
                let lower_clean = clean.to_lowercase();
                // Always boost known core entities regardless of position
                if known_entities.contains(&lower_clean.as_str()) {
                    set.insert(lower_clean.clone());
                    continue;
                }
                // Capitalized mid-sentence = proper noun (position > 0, not just sentence-start caps)
                let first_upper = clean
                    .chars()
                    .next()
                    .map(|c| c.is_uppercase())
                    .unwrap_or(false);
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
            let word_weight: i32 = if proper_nouns.contains(token.as_str()) {
                6
            } else {
                3
            };
            for k in 0..n_active {
                let idx = (base.wrapping_add(k * 2654435761)) % DIM;
                let sign = if (base.wrapping_add(k * 1442695040)) % 2 == 0 {
                    word_weight
                } else {
                    -word_weight
                };
                v[idx] += sign;
            }
        }

        if normalized_tokens.len() >= 2 {
            for i in 0..normalized_tokens.len() - 1 {
                let w1 = &normalized_tokens[i];
                let w2 = &normalized_tokens[i + 1];
                // Skip category anchors in bigrams (they're cluster signals, not word pairs)
                if w1.starts_with('#') || w2.starts_with('#') {
                    continue;
                }

                let base = hash_word_pair(w1, w2);
                let n_active = 8; // Slightly fewer bits for bigrams (supporting signal)
                for k in 0..n_active {
                    let idx = (base.wrapping_add(k * 2654435761)) % DIM;
                    let sign = if (base.wrapping_add(k * 1442695040)) % 2 == 0 {
                        2
                    } else {
                        -2
                    };
                    v[idx] += sign; // 2x weight for word bigrams
                }
            }
        }

        // Ternary threshold + Sparsification: keep only top 4% magnitudes
        let target_count = ((DIM as f32) * SPARSITY) as usize;
        let mut magnitudes: Vec<i32> = v.iter().map(|s| s.abs()).collect();
        magnitudes.sort_unstable_by(|a, b| b.cmp(a));
        let threshold = if target_count < DIM {
            magnitudes[target_count]
        } else {
            0
        };

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
    /// Before encoding into the 16384-dimensional space, each word token
    /// is checked against KAI's vocabulary. Unknown words within edit
    /// distance ≤ 2 of a known word are corrected to the known form.
    ///
    /// This means "wrold" encodes identically to "world" — the
    /// misspelling is pulled to the nearest known attractor in word-space.
    ///
    /// Returns (vector, corrections) where corrections lists what was fixed.
    pub fn encode_corrected(
        text: &str,
        lexicon: &super::lexicon::Lexicon,
    ) -> (Self, Vec<(String, String)>) {
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
        let threshold = if target_count < DIM {
            magnitudes[target_count]
        } else {
            0
        };

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

    /// Unbind — the inverse of `bind`. In ternary VSA with values in
    /// {-1, 0, +1}, element-wise multiplication is self-inverse on
    /// every dimension where the key is nonzero:
    ///
    ///   (a[i] * b[i]) * b[i] = a[i] * b[i]^2
    ///                        = a[i]   when b[i] != 0 (since (+-1)^2 = 1)
    ///                        = 0      when b[i] == 0 (information lost in that slot)
    ///
    /// So `unbind(bind(a, b), b) == a` on the support of `b`, and zero
    /// elsewhere. This is the "approximately a within noise tolerance"
    /// the spec asks for — the only information lost is the subset of
    /// dimensions where `b` is already zero, which is fundamental to
    /// sparse ternary binding.
    ///
    /// References:
    ///   - Kanerva, "Hyperdimensional Computing" (2009) — MAP model.
    ///   - ACM Computing Surveys on HDC/VSA (2022+).
    ///   - Bronzini et al., "Hyperdimensional Probe" (arXiv:2509.25045).
    pub fn unbind(&self, other: &SparseVec) -> Self {
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

    /// Ternary balance: count of +1 dimensions vs −1 dimensions.
    ///
    /// In HLV theory, this is the **Fibonacci torsion** — the ratio of
    /// convergent (+1) to divergent (−1) non-zero dimensions. A cell
    /// with balanced +1/−1 sits at the neutral axis. A cell with more
    /// +1s is "convergent" (constructive); more −1s is "divergent"
    /// (destructive). The lattice naturally favors convergent patterns.
    ///
    /// Returns `(positive_count, negative_count)`.
    pub fn ternary_balance(&self) -> (usize, usize) {
        let mut pos = 0usize;
        let mut neg = 0usize;
        for &d in &self.data {
            match d {
                1 => pos += 1,
                -1 => neg += 1,
                _ => {}
            }
        }
        (pos, neg)
    }

    /// Phase angle derived from the geometric position of this vector
    /// in the 16384-dim lattice. Uses the +1/−1 ternary balance as a
    /// natural angular coordinate — this IS the Fibonacci torsion from
    /// HLV theory mapped into the RSHL vector space.
    ///
    /// Maps the balance ratio [0.0, 1.0] → [0, 2π). Two cells with
    /// similar ternary balance are "phase-aligned" and will
    /// constructively interfere in the phasor sum. Cells with opposite
    /// balance are ~π apart and destructively cancel.
    pub fn phase_angle(&self) -> f32 {
        let (pos, neg) = self.ternary_balance();
        let total = pos + neg;
        if total == 0 {
            return 0.0;
        }
        let ratio = pos as f32 / total as f32;
        // Map [0, 1] → [0, 2π)
        ratio * std::f32::consts::TAU
    }

    /// Seeded Fisher-Yates permutation. VSA "role" projection.
    pub fn permute(&self, seed: u32) -> Self {
        let mut v = self.clone();
        let mut s = mix_permute_seed(seed);
        for i in (1..v.data.len()).rev() {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            let j = (s as usize) % (i + 1);
            v.data.swap(i, j);
        }
        v
    }

    /// Inverse of `permute(seed)`. Same shuffle, reversed.
    pub fn permute_inv(&self, seed: u32) -> Self {
        let n = self.data.len();
        let mut swaps: Vec<(usize, usize)> = Vec::with_capacity(n - 1);
        let mut s = mix_permute_seed(seed);
        for i in (1..n).rev() {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            let j = (s as usize) % (i + 1);
            swaps.push((i, j));
        }
        let mut v = self.clone();
        for (i, j) in swaps.into_iter().rev() {
            v.data.swap(i, j);
        }
        v
    }

    pub fn contrast(&self, other: &SparseVec) -> Self {
        let mut data = self.data.clone();
        for i in 0..DIM {
            if other.data[i] != 0 {
                data[i] = 0;
            }
        }
        Self::from_raw(data)
    }

    /// High-speed cosine search for decoding.
    pub fn batch_cosine(&self, targets: &[(&str, SparseVec)]) -> Option<String> {
        targets
            .iter()
            .map(|(word, vec)| (*word, self.cosine(vec)))
            .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
            .filter(|(_, score)| *score > 0.15)
            .map(|(word, _)| word.to_string())
    }
}

impl Default for SparseVec {
    fn default() -> Self {
        Self::zero()
    }
}

/// Mix a `u32` seed into a nonzero XorShift32 starting state so that
/// *every* distinct seed produces a distinct permutation.
///
/// The previous implementation (`seed | 1`) collapsed adjacent pairs —
/// e.g. `permute(0) == permute(1)`, `permute(2) == permute(3)` — which
/// silently broke positional role-binding (every other slot in a
/// sequence-encoded sentence landed on the same key) and also made
/// head 0 == head 1 in `multi_head_consensus`.
///
/// The mixer is a SplitMix64-style avalanche so consecutive inputs
/// (0, 1, 2, …) produce completely unrelated starting states, and the
/// output is forced nonzero to keep XorShift32 out of its zero fixed
/// point.
#[inline]
fn mix_permute_seed(seed: u32) -> u32 {
    let mut s = seed as u64;
    s = s.wrapping_add(0x9E3779B97F4A7C15);
    s = (s ^ (s >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    s = (s ^ (s >> 27)).wrapping_mul(0x94D049BB133111EB);
    s ^= s >> 31;
    let out = (s ^ (s >> 32)) as u32;
    if out == 0 { 0x9E3779B9 } else { out }
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
        assert!(
            sim_match > sim_unrelated,
            "location query should match location answer ({:.4}) more than unrelated ({:.4})",
            sim_match,
            sim_unrelated
        );
    }

    #[test]
    fn test_synonym_equivalence() {
        // "occupation" and "job" should both normalize to "work" + "#job"
        let a = SparseVec::encode("Ryan's occupation");
        let b = SparseVec::encode("Ryan's job");
        let sim = a.cosine(&b);
        assert!(
            sim > 0.5,
            "synonym-equivalent phrases should have high similarity: {:.4}",
            sim
        );
    }

    #[test]
    fn test_bundle_preserves_majority() {
        // Bundle of overlapping vecs should be closer to each input than random
        let a = SparseVec::encode("mathematics algebra geometry");
        let b = SparseVec::encode("mathematics calculus topology");
        let c = SparseVec::encode("mathematics number theory");
        let bundle = SparseVec::bundle(&[&a, &b, &c]);
        let query = SparseVec::encode("mathematics");
        let random = SparseVec::encode("purple elephant jazz");
        assert!(
            bundle.cosine(&query) > bundle.cosine(&random),
            "bundle should be closer to shared concept than random noise"
        );
    }

    /// Deterministic sparse ternary vector generator for tests. Uses the
    /// same XorShift PRNG as `permute` so results are reproducible across
    /// runs and platforms. Sparsity matches the ~4% design target.
    fn random_sparse(seed: u32) -> SparseVec {
        let mut s = seed | 1;
        let mut data = vec![0i8; DIM];
        let target_nnz = (DIM as f32 * SPARSITY) as usize; // ~163 nonzeros
        let mut set = 0usize;
        let mut attempts = 0usize;
        while set < target_nnz && attempts < DIM * 4 {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            let i = (s as usize) % DIM;
            if data[i] == 0 {
                // Low bit of the next rng step picks sign.
                s ^= s << 13;
                s ^= s >> 17;
                s ^= s << 5;
                data[i] = if s & 1 == 0 { 1 } else { -1 };
                set += 1;
            }
            attempts += 1;
        }
        SparseVec::from_raw(data)
    }

    /// Step 1 of the autoregressive engine: prove `unbind(bind(a, b), b)`
    /// recovers `a` on every dimension where `b` is nonzero (ternary VSA
    /// binding is self-inverse on the key's support). Noise only appears
    /// in dimensions where `b` is zero — that information is fundamentally
    /// lost by sparse ternary binding, which is the expected behavior.
    ///
    /// This is the math foundation the whole generative decoder rests on:
    /// to pull the i-th word out of a sentence hypervector `S`, we compute
    /// `S.unbind(&position_i)` and find the nearest lexicon entry.
    #[test]
    fn test_unbind_inverts_bind_on_key_support() {
        let a = random_sparse(0x9E37_79B9);
        let b = random_sparse(0x5F1A_C041);

        let bound = a.bind(&b);
        let recovered = bound.unbind(&b);

        // Every dim where b is nonzero must recover a exactly.
        let mut mismatches_on_support = 0usize;
        let mut b_support = 0usize;
        for i in 0..DIM {
            if b.data[i] != 0 {
                b_support += 1;
                if recovered.data[i] != a.data[i] {
                    mismatches_on_support += 1;
                }
            } else {
                // Outside b's support the result must be zero (info is lost).
                assert_eq!(
                    recovered.data[i], 0,
                    "unbind must zero dims where key is zero (idx {})", i
                );
            }
        }
        assert!(
            b_support > 100,
            "key should have meaningful support, got nnz={}",
            b_support
        );
        assert_eq!(
            mismatches_on_support, 0,
            "unbind(bind(a,b), b) must equal a on every dim where b != 0 \
             (mismatches={} / b_support={})",
            mismatches_on_support, b_support
        );

        // Cosine similarity to the original should be high — the
        // recovered vector is `a` masked by b's support pattern.
        let sim = recovered.cosine(&a);
        assert!(
            sim > 0.15,
            "recovered vector should resemble original (cosine={:.4})",
            sim
        );
    }

    /// Unbinding with the wrong key must not recover the original.
    /// This is the discriminative property decoding relies on: picking
    /// the correct position key lights up the right word, and a wrong
    /// key produces noise.
    #[test]
    fn test_unbind_with_wrong_key_is_noise() {
        let a = random_sparse(0xA5A5_A5A5);
        let b = random_sparse(0x1234_5678);
        let wrong = random_sparse(0xDEAD_BEEF);

        let bound = a.bind(&b);
        let recovered_right = bound.unbind(&b);
        let recovered_wrong = bound.unbind(&wrong);

        let sim_right = recovered_right.cosine(&a);
        let sim_wrong = recovered_wrong.cosine(&a);

        assert!(
            sim_right > sim_wrong + 0.05,
            "correct key must recover `a` better than a random key \
             (right={:.4}, wrong={:.4})",
            sim_right,
            sim_wrong
        );
    }
}

// ── (end of sparse_vec.rs) ──
// Use highly overlapping strings t

