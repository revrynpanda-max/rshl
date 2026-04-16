/// RSHL Sparse Ternary Vector Engine
///
/// 4096-dimensional sparse ternary vectors: each dimension is -1, 0, or +1.
/// Encoding uses character-level trigram hashing.
/// Cosine similarity via dot product / (magnitude * magnitude).
///
/// This is the mathematical core of KAI's memory.

const DIM: usize = 4096;
const SPARSITY: f32 = 0.05; // 5% non-zero

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

    /// Encode a text string into a sparse ternary vector.
    /// Uses character trigram hashing with positional permutation.
    pub fn encode(text: &str) -> Self {
        let mut v = vec![0i32; DIM];
        let lower = text.to_lowercase();
        let chars: Vec<char> = lower.chars().collect();

        if chars.len() < 3 {
            // Short text: use character hashing
            for (i, &ch) in chars.iter().enumerate() {
                let h = hash_char(ch, i);
                let idx = h % DIM;
                v[idx] += if (h / DIM) % 2 == 0 { 1 } else { -1 };
            }
        } else {
            // Trigram encoding with positional permutation
            for i in 0..chars.len().saturating_sub(2) {
                let tri = &chars[i..i + 3];
                let base = hash_trigram(tri);

                // Apply sparse projection
                let n_active = ((DIM as f32) * SPARSITY) as usize;
                for k in 0..n_active {
                    let idx = (base.wrapping_add(k * 2654435761)) % DIM; // Knuth multiplicative hash
                    let sign = if (base.wrapping_add(k * 1442695040)) % 2 == 0 { 1 } else { -1 };

                    // Positional permutation: rotate by position
                    let rotated = (idx + i * 97) % DIM;
                    v[rotated] += sign;
                }
            }
        }

        // Ternary threshold: collapse to -1, 0, +1
        let mut data = vec![0i8; DIM];
        for i in 0..DIM {
            data[i] = if v[i] > 0 { 1 } else if v[i] < 0 { -1 } else { 0 };
        }

        Self { data }
    }

    /// Cosine similarity between two vectors. Returns [-1.0, +1.0].
    pub fn cosine(&self, other: &SparseVec) -> f32 {
        // Hand-optimized: process 8 elements at a time
        let (a, b) = (&self.data, &other.data);
        let mut dot: i32 = 0;
        let mut mag_a: i32 = 0;
        let mut mag_b: i32 = 0;

        // Process in chunks of 8 for auto-vectorization
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

        // Handle remainder
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

    /// Bundle (superpose) multiple vectors. Used for goal vectors and consolidation.
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
        // Majority rule ternary
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

    /// Bind two vectors (element-wise multiply). Used for relational encoding.
    pub fn bind(&self, other: &SparseVec) -> Self {
        let mut data = vec![0i8; DIM];
        for i in 0..DIM {
            data[i] = self.data[i] * other.data[i];
        }
        Self { data }
    }

    /// Count non-zero elements (activity).
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

/// Hash a trigram of characters.
fn hash_trigram(tri: &[char]) -> usize {
    let mut h: usize = 0;
    for (i, &ch) in tri.iter().enumerate() {
        h = h.wrapping_mul(31).wrapping_add(ch as usize);
        h ^= (i + 1).wrapping_mul(2654435761);
    }
    h = h.wrapping_mul(0x9e3779b9);
    h % (usize::MAX / 2) // Keep positive
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
    fn test_bundle_preserves_majority() {
        let a = SparseVec::encode("memory is geometric");
        let b = SparseVec::encode("memory is structure");
        let c = SparseVec::encode("memory is pattern");
        let bundled = SparseVec::bundle(&[&a, &b, &c]);
        // Bundled should be similar to all inputs
        assert!(bundled.cosine(&a) > 0.3);
        assert!(bundled.cosine(&b) > 0.3);
        assert!(bundled.cosine(&c) > 0.3);
    }
}
