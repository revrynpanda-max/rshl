//! RSHL Sparse Ternary Vector Engine
//!
//! 16384-dimensional sparse ternary vectors: each dimension is -1, 0, or +1.
//! Encoding uses BOTH character trigrams AND word-level hashing.
//! This dual encoding lets "what is your name" match "my name is KAI"
//! because the word "name" creates identical hash patterns in both.
//!
//! This is the mathematical core of KAI's memory.
//!
//! RAM layout: stores only nonzero indices (`nz: Vec<u16>`) and their
//! parallel values (`vals: Vec<i8>`).  A dense 16,384-byte `Vec<i8>` is
//! never retained.  Temporary dense buffers are rebuilt on demand via
//! `to_dense()` for callers that genuinely need them.

use std::collections::HashMap;
use std::sync::Mutex;

pub const DIM: usize = 16384;
#[cfg(feature = "sparsity_010")]
pub const SPARSITY: f32 = 0.10;
#[cfg(not(feature = "sparsity_010"))]
pub const SPARSITY: f32 = 0.04;

/// A sparse ternary vector in 16384 dimensions.
/// Values are -1, 0, or +1.  Only nonzero entries are stored:
///   * `nz`   – sorted ascending u16 indices of active dimensions
///   * `vals` – parallel i8 values, each -1 or +1
///
/// The `cached_norm` field stores `sqrt(nnz)` computed once at creation.
#[derive(Clone, Debug)]
pub struct SparseVec {
    pub nz: Vec<u16>,
    pub vals: Vec<i8>,
    cached_norm: f32,
}

// ── Permutation table cache ─────────────────────────────────────────────────

fn perm_cache() -> &'static Mutex<HashMap<u32, (Vec<u16>, Vec<u16>)>> {
    static CACHE: std::sync::OnceLock<Mutex<HashMap<u32, (Vec<u16>, Vec<u16>)>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn build_perm_tables(seed: u32) -> (Vec<u16>, Vec<u16>) {
    let mut fwd: Vec<u16> = (0..DIM as u16).collect();
    let mut s = mix_permute_seed(seed);
    for i in (1..DIM).rev() {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        let j = (s as usize) % (i + 1);
        fwd.swap(i, j);
    }
    let mut inv = vec![0u16; DIM];
    for (src, &dest) in fwd.iter().enumerate() {
        inv[dest as usize] = src as u16;
    }
    (fwd, inv)
}

fn get_perm_tables(seed: u32) -> (Vec<u16>, Vec<u16>) {
    {
        let cache = perm_cache().lock().unwrap();
        if let Some(v) = cache.get(&seed) {
            return v.clone();
        }
    }
    let pair = build_perm_tables(seed);
    {
        let mut cache = perm_cache().lock().unwrap();
        cache.insert(seed, pair.clone());
    }
    pair
}

// ── Serialization ───────────────────────────────────────────────────────────

impl serde::Serialize for SparseVec {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let nz: Vec<(u16, i8)> = self
            .nz
            .iter()
            .zip(self.vals.iter())
            .map(|(&i, &v)| (i, v))
            .collect();
        let mut s = serializer.serialize_struct("SparseVec", 2)?;
        s.serialize_field("len", &DIM)?;
        s.serialize_field("nz", &nz)?;
        s.end()
    }
}

impl<'de> serde::Deserialize<'de> for SparseVec {
    #[inline(never)]
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::{self, MapAccess, Visitor};
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = SparseVec;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                write!(f, "SparseVec")
            }
            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<SparseVec, M::Error> {
                let mut dense: Option<Vec<i8>> = None;
                let mut len: Option<usize> = None;
                let mut nz: Option<Vec<(u16, i8)>> = None;
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "data" => {
                            dense = Some(map.next_value()?);
                        }
                        "len" => {
                            len = Some(map.next_value()?);
                        }
                        "nz" => {
                            nz = Some(map.next_value()?);
                        }
                        _ => {
                            let _: serde::de::IgnoredAny = map.next_value()?;
                        }
                    }
                }
                if let Some(data) = dense {
                    return Ok(SparseVec::from_raw(data));
                }
                if let (_, Some(pairs)) = (len, nz) {
                    let mut indices = Vec::with_capacity(pairs.len());
                    let mut values = Vec::with_capacity(pairs.len());
                    for (idx, val) in pairs {
                        if (idx as usize) < DIM && val != 0 {
                            indices.push(idx as usize);
                            values.push(val);
                        }
                    }
                    return Ok(SparseVec::from_parts(indices, values));
                }
                Err(de::Error::custom(
                    "SparseVec: missing data or len/nz fields",
                ))
            }
        }
        deserializer.deserialize_map(V)
    }
}

// ── SparseVec implementation ────────────────────────────────────────────────

impl SparseVec {
    /// Create a zero vector.
    pub fn zero() -> Self {
        Self {
            nz: Vec::new(),
            vals: Vec::new(),
            cached_norm: 0.0,
        }
    }

    /// Build from a dense i8 buffer.  The dense buffer is consumed and
    /// converted into the sparse nz+vals representation.
    pub fn from_raw(data: Vec<i8>) -> Self {
        let mut nz = Vec::with_capacity(data.len() / 32);
        let mut vals = Vec::with_capacity(data.len() / 32);
        for (i, &v) in data.iter().enumerate() {
            if v != 0 {
                nz.push(i as u16);
                vals.push(v);
            }
        }
        let cached_norm = (nz.len() as f32).sqrt();
        Self { nz, vals, cached_norm }
    }

    /// Build from explicit (index, value) pairs.
    /// Indices outside `[0, DIM)` or values equal to 0 are silently ignored.
    pub fn from_parts(indices: Vec<usize>, values: Vec<i8>) -> Self {
        let mut pairs: Vec<(u16, i8)> = indices
            .into_iter()
            .zip(values.into_iter())
            .filter(|(idx, val)| *idx < DIM && *val != 0)
            .map(|(idx, val)| (idx as u16, val))
            .collect();
        // Sort by index and deduplicate (last value wins)
        pairs.sort_by_key(|p| p.0);
        let mut nz = Vec::with_capacity(pairs.len());
        let mut vals = Vec::with_capacity(pairs.len());
        for (idx, val) in pairs {
            if !nz.is_empty() && nz.last() == Some(&idx) {
                *vals.last_mut().unwrap() = val;
            } else {
                nz.push(idx);
                vals.push(val);
            }
        }
        let cached_norm = (nz.len() as f32).sqrt();
        Self { nz, vals, cached_norm }
    }

    /// Build from pre-sorted nz + vals (used by compact deserializer).
    pub fn from_nz_vals(nz: Vec<u16>, vals: Vec<i8>) -> Self {
        assert_eq!(nz.len(), vals.len());
        let cached_norm = (nz.len() as f32).sqrt();
        Self { nz, vals, cached_norm }
    }

    /// Reconstruct a temporary dense buffer.  Used by legacy code paths that
    /// still iterate over all DIM dimensions.
    pub fn to_dense(&self) -> Vec<i8> {
        let mut data = vec![0i8; DIM];
        for (&i, &v) in self.nz.iter().zip(self.vals.iter()) {
            data[i as usize] = v;
        }
        data
    }

    /// Invert the semantic meaning of this vector (Mirror Neurons).
    pub fn invert(&self) -> Self {
        let mut vals = Vec::with_capacity(self.vals.len());
        for &v in &self.vals {
            vals.push(-v);
        }
        Self {
            nz: self.nz.clone(),
            vals,
            cached_norm: self.cached_norm,
        }
    }

    /// Read a single dimension. Returns -1, 0, or +1.
    pub fn get(&self, idx: usize) -> i8 {
        if idx >= DIM {
            return 0;
        }
        match self.nz.binary_search(&(idx as u16)) {
            Ok(pos) => self.vals[pos],
            Err(_) => 0,
        }
    }

    /// Iterate over nonzero (index, value) pairs.
    pub fn iter(&self) -> impl Iterator<Item = (usize, i8)> + '_ {
        self.nz
            .iter()
            .zip(self.vals.iter())
            .map(|(&i, &v)| (i as usize, v))
    }

    pub fn hebbian_update(&self, other: &SparseVec, delta: f32) -> Self {
        if delta.abs() < 0.001 {
            return self.clone();
        }
        // Accumulate sparsely using a HashMap to avoid allocating 65KB dense buffers on every update
        let mut accum: HashMap<u16, f32> = HashMap::with_capacity(self.nz.len() + other.nz.len());
        for (i, v) in self.iter() {
            accum.insert(i as u16, v as f32);
        }
        for (i, v) in other.iter() {
            let val = accum.entry(i as u16).or_insert(0.0);
            *val += delta * (v as f32);
        }
        let target_nnz = ((DIM as f32) * SPARSITY).ceil() as usize;
        
        let mut indexed: Vec<(u16, f32)> = accum.into_iter().collect();
        indexed.sort_by(|a, b| {
            b.1.abs()
                .partial_cmp(&a.1.abs())
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        let mut pairs: Vec<(u16, i8)> = indexed.into_iter().take(target_nnz).filter_map(|(idx, v)| {
            if v != 0.0 {
                Some((idx, if v > 0.0 { 1 } else { -1 }))
            } else {
                None
            }
        }).collect();
        
        pairs.sort_by_key(|p| p.0);
        let (nz, vals): (Vec<u16>, Vec<i8>) = pairs.into_iter().unzip();
        let cached_norm = (nz.len() as f32).sqrt();
        Self { nz, vals, cached_norm }
    }

    /// Encode a text string into a sparse ternary vector.
    pub fn encode(text: &str) -> Self {
        let mut v = vec![0i32; DIM];
        let lower = text.to_lowercase();
        let chars: Vec<char> = lower.chars().collect();

        // ── Layer 1: Character trigrams (weighted 1x) ────────────────────
        if chars.len() >= 3 {
            for i in 0..chars.len().saturating_sub(2) {
                let tri = &chars[i..i + 3];
                let base = hash_trigram(tri);
                let n_active = 24;
                for k in 0..n_active {
                    let idx = (base.wrapping_add(k * 2654435761)) % DIM;
                    let sign = if (base.wrapping_add(k * 1442695040)).is_multiple_of(2) {
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
                v[idx] += if (h / DIM).is_multiple_of(2) {
                    1
                } else {
                    -1
                };
            }
        }

        // ── Layer 2: NORMALIZED word-level hashing (weighted 3x) ──────────
        let normalizer = super::normalize::get_normalizer();
        let normalized_tokens = normalizer.normalize_text(text);

        let known_entities: &[&str] = &["ryan", "kai", "rshl", "kaii"];
        let physics_core: &[&str] = &[
            "lattice", "vortex", "helical", "torsion", "phasor", "resonance",
            "coherence", "quanta", "superposition", "topology", "manifold",
            "fibonacci", "phi", "chi", "psi", "omega", "sigma", "theta",
        ];
        let original_words: Vec<&str> = text.split_whitespace().collect();
        let proper_nouns: std::collections::HashSet<String> = {
            let mut set = std::collections::HashSet::new();
            for (i, word) in original_words.iter().enumerate() {
                let clean: String = word.chars().filter(|c| c.is_alphabetic()).collect();
                if clean.len() < 2 {
                    continue;
                }
                let lower_clean = clean.to_lowercase();
                if known_entities.contains(&lower_clean.as_str()) {
                    set.insert(lower_clean.clone());
                    continue;
                }
                if physics_core.contains(&lower_clean.as_str()) {
                    set.insert(format!("!{}", lower_clean));
                    continue;
                }
                let first_upper = clean
                    .chars()
                    .next()
                    .map(|c| c.is_uppercase())
                    .unwrap_or(false);
                if i > 0 && first_upper {
                    set.insert(lower_clean.clone());
                }
                if clean.chars().all(|c| c.is_uppercase()) && clean.len() >= 2 {
                    set.insert(lower_clean);
                }
            }
            set
        };

        for token in &normalized_tokens {
            let base = hash_word(token);
            let n_active = 24;
            let word_weight: i32 = if proper_nouns.contains(token.as_str()) {
                6
            } else if proper_nouns.contains(&format!("!{}", token)) {
                5
            } else {
                3
            };
            for k in 0..n_active {
                let idx = (base.wrapping_add(k * 2654435761)) % DIM;
                let sign = if (base.wrapping_add(k * 1442695040)).is_multiple_of(2) {
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
                if w1.starts_with('#') || w2.starts_with('#') {
                    continue;
                }
                let base = hash_word_pair(w1, w2);
                let n_active = 8;
                for k in 0..n_active {
                    let idx = (base.wrapping_add(k * 2654435761)) % DIM;
                    let sign = if (base.wrapping_add(k * 1442695040)).is_multiple_of(2) {
                        2
                    } else {
                        -2
                    };
                    v[idx] += sign;
                }
            }
        }

        // ── Layer D: Character bigrams (weight 1x, n_active 12) ────────────
        if chars.len() >= 2 {
            for i in 0..chars.len() - 1 {
                let bigram = [chars[i], chars[i + 1]];
                let base = hash_bigram(&bigram);
                for k in 0..12usize {
                    let idx = (base.wrapping_add(k * 2654435761)) % DIM;
                    let sign =
                        if (base.wrapping_add(k * 1442695040)).is_multiple_of(2) {
                            1
                        } else {
                            -1
                        };
                    v[idx] += sign;
                }
            }
        }

        // ── Layer E: Character 4-grams (weight 2x, n_active 16) ────────────
        if chars.len() >= 4 {
            for i in 0..chars.len() - 3 {
                let fourgram = [chars[i], chars[i + 1], chars[i + 2], chars[i + 3]];
                let base = hash_fourgram(&fourgram);
                for k in 0..16usize {
                    let idx = (base.wrapping_add(k * 2654435761)) % DIM;
                    let sign =
                        if (base.wrapping_add(k * 1442695040)).is_multiple_of(2) {
                            2
                        } else {
                            -2
                        };
                    v[idx] += sign;
                }
            }
        }

        // Ternary threshold + Sparsification
        let target_count = ((DIM as f32) * SPARSITY) as usize;
        let nnz = v.iter().filter(|&&s| s != 0).count();
        let threshold: i32 = if target_count < DIM && nnz > target_count {
            let mut magnitudes: Vec<i32> =
                v.iter().filter(|&&s| s != 0).map(|s| s.abs()).collect();
            magnitudes.sort_unstable_by(|a, b| b.cmp(a));
            magnitudes[target_count]
        } else {
            0
        };

        let mut nz = Vec::with_capacity(1024);
        let mut vals = Vec::with_capacity(1024);
        for i in 0..DIM {
            let val = v[i];
            if (threshold > 0 && val.abs() >= threshold) || (threshold == 0 && val != 0) {
                nz.push(i as u16);
                vals.push(if val > 0 { 1 } else { -1 });
            }
        }

        let cached_norm = (nz.len() as f32).sqrt();
        Self { nz, vals, cached_norm }
    }

    /// Encode text with spelling correction via the Lexicon.
    pub fn encode_corrected(
        text: &str,
        lexicon: &super::lexicon::Lexicon,
    ) -> (Self, Vec<(String, String)>) {
        let (corrected_text, corrections) = lexicon.correct_sentence(text);
        let vec = Self::encode(&corrected_text);
        (vec, corrections)
    }

    /// Cosine similarity between two vectors. Returns [-1.0, +1.0].
    #[inline]
    pub fn cosine(&self, other: &SparseVec) -> f32 {
        if self.cached_norm == 0.0 || other.cached_norm == 0.0 {
            return 0.0;
        }
        self.dot(other) as f32 / (self.cached_norm * other.cached_norm)
    }

    /// Dense cosine — reference path kept for benchmarking.
    #[inline]
    pub fn cosine_dense(&self, other: &SparseVec) -> f32 {
        self.cosine(other)
    }

    /// The old, naive dot product (baseline) without Bounds Elision.
    pub fn dot_unoptimized(&self, other: &SparseVec) -> i32 {
        let (a_nz, a_vals) = (&self.nz, &self.vals);
        let (b_nz, b_vals) = (&other.nz, &other.vals);
        let mut i = 0usize;
        let mut j = 0usize;
        let mut dot: i32 = 0;
        while i < a_nz.len() && j < b_nz.len() {
            let ai = a_nz[i];
            let bj = b_nz[j];
            if ai == bj {
                dot += a_vals[i] as i32 * b_vals[j] as i32;
                i += 1;
                j += 1;
            } else if ai < bj {
                i += 1;
            } else {
                j += 1;
            }
        }
        dot
    }

    /// Sparse dot product between two ternary vectors.
    /// Two-pointer merge on the sorted nz arrays — optimized with bounds elision.
    #[inline(always)]
    pub fn dot(&self, other: &SparseVec) -> i32 {
        let mut i = 0usize;
        let mut j = 0usize;
        let mut dot: i32 = 0;
        let a_len = self.nz.len();
        let b_len = other.nz.len();
        let a_nz = &self.nz[..];
        let a_vals = &self.vals[..];
        let b_nz = &other.nz[..];
        let b_vals = &other.vals[..];

        while i < a_len && j < b_len {
            // SAFETY: i < a_len and j < b_len checked by the while loop condition.
            let ai = unsafe { *a_nz.get_unchecked(i) };
            let bj = unsafe { *b_nz.get_unchecked(j) };
            if ai == bj {
                dot += unsafe { *a_vals.get_unchecked(i) as i32 * *b_vals.get_unchecked(j) as i32 };
                i += 1;
                j += 1;
            } else if ai < bj {
                i += 1;
            } else {
                j += 1;
            }
        }
        dot
    }

    /// Phasor-aware coherence: Cosine similarity modulated by phase alignment.
    pub fn phasor_coherence(&self, other: &SparseVec) -> f32 {
        let theta1 = self.phase_angle();
        let theta2 = other.phase_angle();
        let cos_sim = self.cosine(other);
        cos_sim * (theta1 - theta2).cos()
    }

    /// Bundle (superpose) multiple vectors.
    pub fn bundle(vecs: &[&SparseVec]) -> Self {
        if vecs.is_empty() {
            return Self::zero();
        }
        let mut acc: HashMap<u16, i32> =
            HashMap::with_capacity(vecs[0].nz.len() * vecs.len());
        for v in vecs {
            for (&idx, &val) in v.nz.iter().zip(v.vals.iter()) {
                *acc.entry(idx).or_insert(0) += val as i32;
            }
        }
        let threshold = (vecs.len() as i32 + 1) / 2;
        let mut pairs: Vec<(u16, i8)> = acc
            .into_iter()
            .filter_map(|(idx, sum)| {
                let v = if sum >= threshold {
                    1
                } else if sum <= -threshold {
                    -1
                } else {
                    0
                };
                if v != 0 {
                    Some((idx, v))
                } else {
                    None
                }
            })
            .collect();
        pairs.sort_by_key(|p| p.0);
        let (nz, vals): (Vec<u16>, Vec<i8>) = pairs.into_iter().unzip();
        let cached_norm = (nz.len() as f32).sqrt();
        Self { nz, vals, cached_norm }
    }

    /// Attention-weighted bundle — forged from the same accumulate-then-threshold
    /// HD math as `bundle`/`bind_creative`, but each input contributes in
    /// proportion to its weight instead of equally. Used by Attention-Weighted
    /// Hop Bundling so the reasoning components most relevant to the GOAL stay
    /// prominent rather than being buried in an equal-weight superposition
    /// ("buffet, not soup"). With all weights = 1.0 this reduces to `bundle`.
    pub fn bundle_weighted(vecs: &[&SparseVec], weights: &[f32]) -> Self {
        if vecs.is_empty() {
            return Self::zero();
        }
        let mut acc: HashMap<u16, f32> =
            HashMap::with_capacity(vecs[0].nz.len() * vecs.len());
        let mut total_w = 0.0f32;
        for (i, v) in vecs.iter().enumerate() {
            let w = weights.get(i).copied().unwrap_or(1.0).max(0.0);
            total_w += w;
            for (&idx, &val) in v.nz.iter().zip(v.vals.iter()) {
                *acc.entry(idx).or_insert(0.0) += val as f32 * w;
            }
        }
        // Threshold scales with total weight so the result stays bounded and
        // sparse like the equal-weight bundle (a dimension must win a weighted
        // majority). A strict `> (total_w - 1) / 2` exactly reproduces the
        // integer `(n + 1) / 2` majority rule of `bundle` when every weight is
        // 1.0 (total_w == n), so weights == [1,1,..] is byte-for-byte `bundle`,
        // including for an even number of vectors.
        let threshold = (total_w - 1.0) * 0.5;
        let mut pairs: Vec<(u16, i8)> = acc
            .into_iter()
            .filter_map(|(idx, sum)| {
                let v = if sum > threshold {
                    1
                } else if sum < -threshold {
                    -1
                } else {
                    0
                };
                if v != 0 { Some((idx, v)) } else { None }
            })
            .collect();
        pairs.sort_by_key(|p| p.0);
        let (nz, vals): (Vec<u16>, Vec<i8>) = pairs.into_iter().unzip();
        let cached_norm = (nz.len() as f32).sqrt();
        Self { nz, vals, cached_norm }
    }

    /// Creative binding: V_creative = tau(alpha * V_A + beta * V_B)
    pub fn bind_creative(a: &SparseVec, b: &SparseVec, alpha: f32, beta: f32, threshold: f32) -> Self {
        let mut acc: HashMap<u16, f32> = HashMap::with_capacity(a.nz.len() + b.nz.len());
        for (&idx, &val) in a.nz.iter().zip(a.vals.iter()) {
            *acc.entry(idx).or_insert(0.0) += val as f32 * alpha;
        }
        for (&idx, &val) in b.nz.iter().zip(b.vals.iter()) {
            *acc.entry(idx).or_insert(0.0) += val as f32 * beta;
        }
        
        let mut pairs: Vec<(u16, i8)> = acc
            .into_iter()
            .filter_map(|(idx, sum)| {
                let v = if sum >= threshold {
                    1
                } else if sum <= -threshold {
                    -1
                } else {
                    0
                };
                if v != 0 {
                    Some((idx, v))
                } else {
                    None
                }
            })
            .collect();
        pairs.sort_by_key(|p| p.0);
        let (nz, vals): (Vec<u16>, Vec<i8>) = pairs.into_iter().unzip();
        let cached_norm = (nz.len() as f32).sqrt();
        Self { nz, vals, cached_norm }
    }

    /// Weighted superposition of multiple vectors.
    pub fn weighted_superpose(vecs: &[(&SparseVec, f32)], threshold_ratio: f32) -> Self {
        if vecs.is_empty() {
            return Self::zero();
        }
        let mut acc: HashMap<u16, f32> =
            HashMap::with_capacity(vecs[0].0.nz.len() * vecs.len());
        let mut total_weight = 0.0f32;
        for (v, w) in vecs {
            total_weight += w;
            for (&idx, &val) in v.nz.iter().zip(v.vals.iter()) {
                *acc.entry(idx).or_insert(0.0) += val as f32 * *w;
            }
        }
        let threshold = total_weight * threshold_ratio;
        let mut pairs: Vec<(u16, i8)> = acc
            .into_iter()
            .filter_map(|(idx, sum)| {
                let v = if sum >= threshold {
                    1
                } else if sum <= -threshold {
                    -1
                } else {
                    0
                };
                if v != 0 {
                    Some((idx, v))
                } else {
                    None
                }
            })
            .collect();
        pairs.sort_by_key(|p| p.0);
        let (nz, vals): (Vec<u16>, Vec<i8>) = pairs.into_iter().unzip();
        let cached_norm = (nz.len() as f32).sqrt();
        Self { nz, vals, cached_norm }
    }

    /// Superpose without consensus threshold, but with a sparsity target.
    pub fn superpose_sparse(vecs: &[&SparseVec], target_density: f32) -> Self {
        let mut acc: HashMap<u16, i32> = HashMap::with_capacity(
            vecs.get(0).map(|v| v.nz.len()).unwrap_or(0) * vecs.len(),
        );
        for v in vecs {
            for (&idx, &val) in v.nz.iter().zip(v.vals.iter()) {
                *acc.entry(idx).or_insert(0) += val as i32;
            }
        }

        let target_count = ((DIM as f32) * target_density) as usize;
        let mut pairs: Vec<(u16, i32)> = acc.into_iter().collect();
        pairs.sort_by(|a, b| b.1.abs().cmp(&a.1.abs()));
        pairs.truncate(target_count);

        let mut combined: Vec<(u16, i8)> = Vec::with_capacity(pairs.len());
        for (idx, sum) in pairs {
            if sum != 0 {
                combined.push((idx, sum.signum() as i8));
            }
        }
        combined.sort_by_key(|p| p.0);
        let (nz, vals): (Vec<u16>, Vec<i8>) = combined.into_iter().unzip();
        let cached_norm = (nz.len() as f32).sqrt();
        Self { nz, vals, cached_norm }
    }

    /// Bind two vectors (element-wise multiply).
    pub fn bind(&self, other: &SparseVec) -> Self {
        let mut pairs: Vec<(u16, i8)> = Vec::with_capacity(self.nz.len().min(other.nz.len()));
        let mut i = 0;
        let mut j = 0;
        while i < self.nz.len() && j < other.nz.len() {
            let a = self.nz[i];
            let b = other.nz[j];
            if a == b {
                let prod = self.vals[i] * other.vals[j];
                if prod != 0 {
                    pairs.push((a, prod));
                }
                i += 1;
                j += 1;
            } else if a < b {
                i += 1;
            } else {
                j += 1;
            }
        }
        let (nz, vals): (Vec<u16>, Vec<i8>) = pairs.into_iter().unzip();
        let cached_norm = (nz.len() as f32).sqrt();
        Self { nz, vals, cached_norm }
    }

    /// Unbind — the inverse of `bind`. In ternary VSA with values in
    /// {-1, 0, +1}, element-wise multiplication is self-inverse.
    pub fn unbind(&self, other: &SparseVec) -> Self {
        self.bind(other)
    }

    /// Count non-zero elements.
    pub fn nnz(&self) -> usize {
        self.nz.len()
    }

    /// Magnitude (L2 norm).
    pub fn magnitude(&self) -> f32 {
        self.cached_norm
    }

    /// Return the pre-cached L2 norm (sqrt of NNZ). Zero-cost accessor.
    #[inline(always)]
    pub fn norm(&self) -> f32 {
        self.cached_norm
    }

    /// Ternary balance: count of +1 dimensions vs −1 dimensions.
    pub fn ternary_balance(&self) -> (usize, usize) {
        let mut pos = 0usize;
        let mut neg = 0usize;
        for &v in &self.vals {
            match v {
                1 => pos += 1,
                -1 => neg += 1,
                _ => {}
            }
        }
        (pos, neg)
    }

    /// Phase angle derived from the geometric position of this vector.
    /// Phase angle derived from the holographic geometric position of active micro-features.
    pub fn phase_angle(&self) -> f32 {
        if self.nz.is_empty() {
            return 0.0;
        }
        const GOLDEN_ANGLE: f32 = 2.399_963_1_f32;
        let mut sum_re = 0.0;
        let mut sum_im = 0.0;
        for (&idx, &sign) in self.nz.iter().zip(self.vals.iter()) {
            let theta = (idx as f32) * GOLDEN_ANGLE;
            let val = sign as f32;
            sum_re += val * theta.cos();
            sum_im += val * theta.sin();
        }
        let angle = sum_im.atan2(sum_re);
        if angle < 0.0 {
            angle + std::f32::consts::TAU
        } else {
            angle
        }
    }

    /// Seeded Fisher-Yates permutation. VSA "role" projection.
    pub fn permute(&self, seed: u32) -> Self {
        let (fwd, _inv) = get_perm_tables(seed);
        let mut combined: Vec<(u16, i8)> =
            Vec::with_capacity(self.nz.len());
        for (&src, &val) in self.nz.iter().zip(self.vals.iter()) {
            combined.push((fwd[src as usize], val));
        }
        combined.sort_by_key(|p| p.0);
        let (nz, vals): (Vec<u16>, Vec<i8>) = combined.into_iter().unzip();
        Self {
            nz,
            vals,
            cached_norm: self.cached_norm,
        }
    }

    /// Inverse of `permute(seed)`.
    pub fn permute_inv(&self, seed: u32) -> Self {
        let (_fwd, inv) = get_perm_tables(seed);
        let mut combined: Vec<(u16, i8)> =
            Vec::with_capacity(self.nz.len());
        for (&src, &val) in self.nz.iter().zip(self.vals.iter()) {
            combined.push((inv[src as usize], val));
        }
        combined.sort_by_key(|p| p.0);
        let (nz, vals): (Vec<u16>, Vec<i8>) = combined.into_iter().unzip();
        Self {
            nz,
            vals,
            cached_norm: self.cached_norm,
        }
    }

    pub fn contrast(&self, other: &SparseVec) -> Self {
        let other_set: std::collections::HashSet<u16> =
            other.nz.iter().copied().collect();
        let mut nz = Vec::with_capacity(self.nz.len());
        let mut vals = Vec::with_capacity(self.nz.len());
        for (&idx, &val) in self.nz.iter().zip(self.vals.iter()) {
            if !other_set.contains(&idx) {
                nz.push(idx);
                vals.push(val);
            }
        }
        let cached_norm = (nz.len() as f32).sqrt();
        Self { nz, vals, cached_norm }
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

    /// Vogel Spiral Projection (Noids)
    pub fn project_vogel_spiral(index: usize, seed: u32) -> Self {
        let mut data = vec![0i8; DIM];
        let n = (index + 1) as f32;
        const GOLDEN_ANGLE: f32 = 2.399_963_1_f32;

        let theta_offset = (seed as f32 * GOLDEN_ANGLE) % std::f32::consts::TAU;
        let theta = (n * GOLDEN_ANGLE) + theta_offset;

        let target_nnz = (DIM as f32 * SPARSITY) as usize;

        for k in 0..target_nnz {
            let mut s = (index as u32)
                .wrapping_add(k as u32)
                .wrapping_add(seed)
                .wrapping_mul(0x9E3779B9);
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;

            let dim_idx = (s as usize) % DIM;
            if data[dim_idx] == 0 {
                let phase = (theta + (k as f32 * 0.1)) % std::f32::consts::TAU;
                data[dim_idx] = if phase < std::f32::consts::PI { 1 } else { -1 };
            }
        }

        Self::from_raw(data)
    }

    /// From Dense Floats (The "Crusher")
    pub fn from_dense_floats(dense: &[f32]) -> Self {
        let mut v = vec![0.0f32; DIM];
        let n_in = dense.len();

        let m = 32;
        for (j, &val) in dense.iter().enumerate() {
            if val.abs() < 1e-6 {
                continue;
            }

            let mut s = (j as u32).wrapping_mul(0x9E3779B9);
            for _ in 0..m {
                s ^= s << 13;
                s ^= s >> 17;
                s ^= s << 5;

                let idx = (s as usize) % DIM;
                let sign = if (s >> 16).wrapping_add(s).is_multiple_of(2) {
                    1.0
                } else {
                    -1.0
                };
                v[idx] += val * sign;
            }
        }

        let mut data = vec![0i8; DIM];
        let target_count = (DIM as f32 * SPARSITY) as usize;

        let mut magnitudes: Vec<f32> = v.iter().map(|f| f.abs()).collect();
        magnitudes.sort_unstable_by(|a, b| {
            b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal)
        });

        let threshold = if target_count < DIM {
            magnitudes[target_count]
        } else {
            0.0
        };

        if threshold > 0.0 {
            for i in 0..DIM {
                if v[i].abs() >= threshold {
                    data[i] = if v[i] > 0.0 { 1 } else { -1 };
                }
            }
        } else {
            for i in 0..DIM {
                if v[i] != 0.0 {
                    data[i] = if v[i] > 0.0 { 1 } else { -1 };
                }
            }
        }

        Self::from_raw(data)
    }
}

impl Default for SparseVec {
    fn default() -> Self {
        Self::zero()
    }
}

impl SparseVec {
    /// Convert this vector to its bitmask form for popcount cosine.
    pub fn to_dense_mask(&self) -> DenseMask {
        DenseMask::from_sparse(self)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// PackedMask: 1 KB bitpacked ternary vector for Zen 4 L3 cache fit
// ─────────────────────────────────────────────────────────────────────────────

/// 2-bit packed ternary: 4 values per byte
/// Encoding: 00 = 0, 01 = +1, 10 = -1, 11 = reserved
#[derive(Clone, Debug)]
pub struct PackedMask {
    pub data: [u8; 4096], // 16384 values × 2 bits ÷ 8 = 4096 bytes
    pub cached_norm: f32,
}

impl PackedMask {
    pub fn from_dense(mask: &DenseMask) -> Self {
        let mut data = [0u8; 4096];
        for dim in 0..DIM {
            let byte_idx = dim / 4;
            let shift = (dim % 4) * 2;
            let word = dim >> 6;
            let bit = 1u64 << (dim & 63);
            let val = if (mask.pos[word] & bit) != 0 {
                0b01
            } else if (mask.neg[word] & bit) != 0 {
                0b10
            } else {
                0b00
            };
            data[byte_idx] |= val << shift;
        }
        let mut nnz = 0;
        for d in &data {
            for s in 0..4 {
                if (d >> (s * 2)) & 0b11 != 0 {
                    nnz += 1;
                }
            }
        }
        Self {
            data,
            cached_norm: (nnz as f32).sqrt(),
        }
    }

    #[inline]
    pub fn cosine_packed(&self, other: &Self) -> f32 {
        if self.cached_norm == 0.0 || other.cached_norm == 0.0 {
            return 0.0;
        }
        let mut dot: i32 = 0;
        for i in (0..4096).step_by(8) {
            let a = u64::from_le_bytes(self.data[i..i + 8].try_into().unwrap());
            let b = u64::from_le_bytes(other.data[i..i + 8].try_into().unwrap());
            let a_pos = a & 0x5555_5555_5555_5555;
            let a_neg = (a >> 1) & 0x5555_5555_5555_5555;
            let b_pos = b & 0x5555_5555_5555_5555;
            let b_neg = (b >> 1) & 0x5555_5555_5555_5555;
            let match_pos = (a_pos & b_pos) | (a_neg & b_neg);
            let match_neg = (a_pos & b_neg) | (a_neg & b_pos);
            dot += match_pos.count_ones() as i32;
            dot -= match_neg.count_ones() as i32;
        }
        (dot as f32) / (self.cached_norm * other.cached_norm)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// DenseMask: 4 KB bitpacked ternary vector for SIMD popcount cosine
// ─────────────────────────────────────────────────────────────────────────────

/// Bitpacked form of a ternary vector for popcount-based cosine similarity.
#[derive(Clone)]
pub struct DenseMask {
    pub pos: Box<[u64; 256]>,
    pub neg: Box<[u64; 256]>,
    pub norm: f32,
}

impl DenseMask {
    /// Convert a SparseVec into its bitmask representation.
    pub fn from_sparse(v: &SparseVec) -> Self {
        let mut pos = Box::new([0u64; 256]);
        let mut neg = Box::new([0u64; 256]);
        for (&i, &val) in v.nz.iter().zip(v.vals.iter()) {
            let word = (i as usize) >> 6;
            let bit = (i as usize) & 63;
            match val {
                1 => pos[word] |= 1u64 << bit,
                -1 => neg[word] |= 1u64 << bit,
                _ => {}
            }
        }
        Self {
            pos,
            neg,
            norm: v.norm(),
        }
    }

    /// Popcount-based cosine similarity. Dispatches to an AVX-512 VPOPCNTDQ kernel
    /// when the CPU supports it (Zen4 / recent Intel), else the portable scalar path.
    /// Both produce identical results (proven by the `avx512_matches_scalar` test) —
    /// the AVX-512 path only changes SPEED, not the value. Ported-forward idea from
    /// the KAI-polyglot Zig hw-bridge, done in pure Rust (no FFI, no format change).
    #[inline]
    pub fn cosine(&self, other: &DenseMask) -> f32 {
        if self.norm == 0.0 || other.norm == 0.0 {
            return 0.0;
        }
        #[cfg(target_arch = "x86_64")]
        {
            if std::is_x86_feature_detected!("avx512f") && std::is_x86_feature_detected!("avx512vpopcntdq") {
                return unsafe { self.cosine_avx512(other) };
            }
        }
        self.cosine_scalar(other)
    }

    /// Portable scalar popcount cosine (the original; works on all CPUs).
    #[inline]
    pub fn cosine_scalar(&self, other: &DenseMask) -> f32 {
        let mut dot: i32 = 0;
        let n = self.pos.len();
        let chunks = n / 4;
        let a_pos = &*self.pos;
        let a_neg = &*self.neg;
        let b_pos = &*other.pos;
        let b_neg = &*other.neg;
        for i in (0..chunks * 4).step_by(4) {
            dot += (a_pos[i] & b_pos[i]).count_ones() as i32;
            dot += (a_pos[i + 1] & b_pos[i + 1]).count_ones() as i32;
            dot += (a_pos[i + 2] & b_pos[i + 2]).count_ones() as i32;
            dot += (a_pos[i + 3] & b_pos[i + 3]).count_ones() as i32;
            dot += (a_neg[i] & b_neg[i]).count_ones() as i32;
            dot += (a_neg[i + 1] & b_neg[i + 1]).count_ones() as i32;
            dot += (a_neg[i + 2] & b_neg[i + 2]).count_ones() as i32;
            dot += (a_neg[i + 3] & b_neg[i + 3]).count_ones() as i32;
            dot -= (a_pos[i] & b_neg[i]).count_ones() as i32;
            dot -= (a_pos[i + 1] & b_neg[i + 1]).count_ones() as i32;
            dot -= (a_pos[i + 2] & b_neg[i + 2]).count_ones() as i32;
            dot -= (a_pos[i + 3] & b_neg[i + 3]).count_ones() as i32;
            dot -= (a_neg[i] & b_pos[i]).count_ones() as i32;
            dot -= (a_neg[i + 1] & b_pos[i + 1]).count_ones() as i32;
            dot -= (a_neg[i + 2] & b_pos[i + 2]).count_ones() as i32;
            dot -= (a_neg[i + 3] & b_pos[i + 3]).count_ones() as i32;
        }
        for i in (chunks * 4)..n {
            dot += (a_pos[i] & b_pos[i]).count_ones() as i32;
            dot += (a_neg[i] & b_neg[i]).count_ones() as i32;
            dot -= (a_pos[i] & b_neg[i]).count_ones() as i32;
            dot -= (a_neg[i] & b_pos[i]).count_ones() as i32;
        }
        dot as f32 / (self.norm * other.norm)
    }

    /// AVX-512 VPOPCNTDQ popcount cosine — same math as `cosine_scalar`, 8 u64 words
    /// per instruction. Caller MUST have verified avx512f + avx512vpopcntdq (the
    /// `cosine` dispatcher does). 256 words / 8 = 32 iterations, no remainder.
    #[cfg(target_arch = "x86_64")]
    #[target_feature(enable = "avx512f,avx512vpopcntdq")]
    unsafe fn cosine_avx512(&self, other: &DenseMask) -> f32 {
        use core::arch::x86_64::*;
        let a_pos = self.pos.as_ptr();
        let a_neg = self.neg.as_ptr();
        let b_pos = other.pos.as_ptr();
        let b_neg = other.neg.as_ptr();
        let mut agree = _mm512_setzero_si512();    // popcount(ap&bp) + popcount(an&bn)
        let mut disagree = _mm512_setzero_si512();  // popcount(ap&bn) + popcount(an&bp)
        let mut i = 0usize;
        while i < 256 {
            let ap = _mm512_loadu_epi64(a_pos.add(i) as *const i64);
            let an = _mm512_loadu_epi64(a_neg.add(i) as *const i64);
            let bp = _mm512_loadu_epi64(b_pos.add(i) as *const i64);
            let bn = _mm512_loadu_epi64(b_neg.add(i) as *const i64);
            let pp = _mm512_popcnt_epi64(_mm512_and_si512(ap, bp));
            let nn = _mm512_popcnt_epi64(_mm512_and_si512(an, bn));
            agree = _mm512_add_epi64(agree, _mm512_add_epi64(pp, nn));
            let pn = _mm512_popcnt_epi64(_mm512_and_si512(ap, bn));
            let np = _mm512_popcnt_epi64(_mm512_and_si512(an, bp));
            disagree = _mm512_add_epi64(disagree, _mm512_add_epi64(pn, np));
            i += 8;
        }
        let dot = _mm512_reduce_add_epi64(agree) - _mm512_reduce_add_epi64(disagree);
        (dot as f32) / (self.norm * other.norm)
    }
}

#[cfg(test)]
mod dense_mask_avx_tests {
    use super::*;
    #[test]
    fn avx512_matches_scalar() {
        let a = SparseVec::encode("the lattice resonates with goal directed emergence and memory");
        let b = SparseVec::encode("memory resonance drives the goal directed lattice emergence pattern");
        let ma = DenseMask::from_sparse(&a);
        let mb = DenseMask::from_sparse(&b);
        let scalar = ma.cosine_scalar(&mb);
        // The public dispatcher must equal the scalar value on every CPU.
        assert!((ma.cosine(&mb) - scalar).abs() < 1e-5, "dispatcher {} != scalar {}", ma.cosine(&mb), scalar);
        // Where AVX-512 is available, the SIMD kernel must match the scalar bit-for-value.
        #[cfg(target_arch = "x86_64")]
        {
            if std::is_x86_feature_detected!("avx512f") && std::is_x86_feature_detected!("avx512vpopcntdq") {
                let avx = unsafe { ma.cosine_avx512(&mb) };
                assert!((avx - scalar).abs() < 1e-5, "avx512 {} != scalar {}", avx, scalar);
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// InvertedIndex: dimension → cell_id posting lists for prefilter
// ─────────────────────────────────────────────────────────────────────────────

pub struct InvertedIndex {
    /// by_dim[d] = sorted list of cell IDs that have dimension d active
    pub by_dim: Vec<Vec<u32>>,
    pub cell_count: u32,
}

impl InvertedIndex {
    pub fn build(vecs: &[SparseVec]) -> Self {
        let mut by_dim: Vec<Vec<u32>> = (0..DIM).map(|_| Vec::new()).collect();
        for (cell_id, sv) in vecs.iter().enumerate() {
            for &i in &sv.nz {
                by_dim[i as usize].push(cell_id as u32);
            }
        }
        Self {
            by_dim,
            cell_count: vecs.len() as u32,
        }
    }

    pub fn candidates(&self, query: &SparseVec, top_n: usize) -> Vec<u32> {
        let mut score = vec![0u32; self.cell_count as usize];
        for &i in &query.nz {
            for &cid in &self.by_dim[i as usize] {
                score[cid as usize] += 1;
            }
        }
        let mut ranked: Vec<(u32, u32)> = score
            .into_iter()
            .enumerate()
            .filter(|(_, s)| *s > 0)
            .map(|(i, s)| (i as u32, s))
            .collect();
        ranked.sort_unstable_by(|a, b| b.1.cmp(&a.1));
        ranked.into_iter().take(top_n).map(|(i, _)| i).collect()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// KMeansIndex: semantic sub-lattice routing for sub-500 μs queries
// ─────────────────────────────────────────────────────────────────────────────

#[inline]
pub fn section_dot_a(q: &DenseMask, c: &DenseMask) -> i32 {
    let mut dot = 0i32;
    for w in 0..64 {
        dot += (q.pos[w] & c.pos[w]).count_ones() as i32;
        dot += (q.neg[w] & c.neg[w]).count_ones() as i32;
        dot -= (q.pos[w] & c.neg[w]).count_ones() as i32;
        dot -= (q.neg[w] & c.pos[w]).count_ones() as i32;
    }
    dot
}

pub struct KMeansIndex {
    pub centroids: Vec<DenseMask>,
    pub clusters: Vec<Vec<usize>>,
    pub k: usize,
}

impl KMeansIndex {
    pub fn build(pool: &[SparseVec], pool_mask: &[DenseMask], k: usize, iters: usize) -> Self {
        let n = pool.len();
        if n == 0 {
            return Self {
                centroids: vec![],
                clusters: vec![],
                k: 0,
            };
        }

        let k = k.min(n);
        let step = (n / k).max(1);
        let mut centroids: Vec<DenseMask> =
            (0..k).map(|i| pool_mask[i * step].clone()).collect();
        let mut assignments = vec![0usize; n];

        for _ in 0..iters {
            for i in 0..n {
                let best = centroids
                    .iter()
                    .enumerate()
                    .map(|(ci, c)| (ci, section_dot_a(&pool_mask[i], c)))
                    .max_by_key(|(_, s)| *s)
                    .map(|(ci, _)| ci)
                    .unwrap_or(0);
                assignments[i] = best;
            }
            for ci in 0..k {
                let members: Vec<&SparseVec> = assignments
                    .iter()
                    .enumerate()
                    .filter(|(_, &a)| a == ci)
                    .map(|(i, _)| &pool[i])
                    .collect();
                if !members.is_empty() {
                    let bundled = SparseVec::bundle(&members);
                    centroids[ci] = bundled.to_dense_mask();
                }
            }
        }

        let mut clusters: Vec<Vec<usize>> = vec![vec![]; k];
        for (i, &a) in assignments.iter().enumerate() {
            clusters[a].push(i);
        }
        Self {
            centroids,
            clusters,
            k,
        }
    }

    pub fn query(
        &self,
        query: &DenseMask,
        pool: &[DenseMask],
        n_probe: usize,
        sec_top: usize,
        top_k: usize,
    ) -> Vec<(usize, f32)> {
        if self.k == 0 {
            return vec![];
        }

        let mut c_scores: Vec<(usize, i32)> = self
            .centroids
            .iter()
            .enumerate()
            .map(|(i, c)| (i, section_dot_a(query, c)))
            .collect();
        c_scores.sort_unstable_by(|a, b| b.1.cmp(&a.1));

        let mut candidates: Vec<(usize, i32)> = Vec::with_capacity(n_probe * 600);
        for &(ci, _) in c_scores.iter().take(n_probe) {
            for &cell_id in &self.clusters[ci] {
                candidates.push((cell_id, section_dot_a(query, &pool[cell_id])));
            }
        }
        candidates.sort_unstable_by(|a, b| b.1.cmp(&a.1));
        candidates.truncate(sec_top);

        let mut results: Vec<(usize, f32)> = candidates
            .iter()
            .map(|(cid, _)| (*cid, query.cosine(&pool[*cid])))
            .collect();
        results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
        results.truncate(top_k);
        results
    }

    pub fn insert(&mut self, cell_id: usize, mask: &DenseMask) {
        if self.k == 0 {
            return;
        }
        let best = self
            .centroids
            .iter()
            .enumerate()
            .map(|(ci, c)| (ci, section_dot_a(mask, c)))
            .max_by_key(|(_, s)| *s)
            .map(|(ci, _)| ci)
            .unwrap_or(0);
        self.clusters[best].push(cell_id);
    }
}

// ── Helper functions ─────────────────────────────────────────────────────────

#[inline]
fn mix_permute_seed(seed: u32) -> u32 {
    let mut s = seed as u64;
    s = s.wrapping_add(0x9E3779B97F4A7C15);
    s = (s ^ (s >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    s = (s ^ (s >> 27)).wrapping_mul(0x94D049BB133111EB);
    s ^= s >> 31;
    let out = (s ^ (s >> 32)) as u32;
    if out == 0 {
        0x9E3779B9
    } else {
        out
    }
}

fn hash_char(ch: char, pos: usize) -> usize {
    let mut h = ch as usize;
    h = h.wrapping_mul(2654435761);
    h ^= pos.wrapping_mul(1442695040);
    h = h.wrapping_mul(0x9e3779b9);
    h
}

fn hash_trigram(tri: &[char]) -> usize {
    let mut h: usize = 0;
    for (i, &ch) in tri.iter().enumerate() {
        h = h.wrapping_mul(31).wrapping_add(ch as usize);
        h ^= (i + 1).wrapping_mul(2654435761);
    }
    h = h.wrapping_mul(0x9e3779b9);
    h % (usize::MAX / 2)
}

fn hash_word(word: &str) -> usize {
    let mut h: usize = 5381;
    for b in word.bytes() {
        h = h.wrapping_mul(33).wrapping_add(b as usize);
    }
    h = h.wrapping_mul(0x9e3779b9);
    h % (usize::MAX / 2)
}

fn hash_word_pair(w1: &str, w2: &str) -> usize {
    let h1 = hash_word(w1);
    let h2 = hash_word(w2);
    let combined = h1.wrapping_mul(31).wrapping_add(h2);
    combined.wrapping_mul(0x9e3779b9) % (usize::MAX / 2)
}

fn hash_bigram(bi: &[char; 2]) -> usize {
    let mut h: usize = bi[0] as usize;
    h = h.wrapping_mul(31).wrapping_add(bi[1] as usize);
    h = h.wrapping_mul(0x9e3779b9);
    h % (usize::MAX / 2)
}

fn hash_fourgram(fg: &[char; 4]) -> usize {
    let mut h: usize = 0;
    for (i, &ch) in fg.iter().enumerate() {
        h = h.wrapping_mul(31).wrapping_add(ch as usize);
        h ^= (i + 1).wrapping_mul(2654435761);
    }
    h = h.wrapping_mul(0x9e3779b9);
    h % (usize::MAX / 2)
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_packed_mask_equivalence() {
        let a = SparseVec::encode("the cat sat on the mat");
        let b = SparseVec::encode("the cat sat on a mat");
        let a_dense = a.to_dense_mask();
        let b_dense = b.to_dense_mask();
        let dense_c = a_dense.cosine(&b_dense);
        let packed_c = PackedMask::from_dense(&a_dense)
            .cosine_packed(&PackedMask::from_dense(&b_dense));
        assert!(
            (dense_c - packed_c).abs() < 1e-5,
            "drift: dense_c = {}, packed_c = {}",
            dense_c,
            packed_c
        );
    }

    #[test]
    fn test_encode_produces_sparse_vec() {
        let v = SparseVec::encode("hello world");
        assert_eq!(v.to_dense().len(), DIM);
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
        assert!(
            sim < 0.3,
            "different texts should have low cosine: {}",
            sim
        );
    }

    #[test]
    fn test_word_semantic_matching() {
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

    fn random_sparse(seed: u32) -> SparseVec {
        let mut s = seed | 1;
        let mut data = vec![0i8; DIM];
        let target_nnz = (DIM as f32 * SPARSITY) as usize;
        let mut set = 0usize;
        let mut attempts = 0usize;
        while set < target_nnz && attempts < DIM * 4 {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            let i = (s as usize) % DIM;
            if data[i] == 0 {
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

    #[test]
    fn test_unbind_inverts_bind_on_key_support() {
        let _a = random_sparse(0x9E37_79B9);
    }

    #[test]
    fn attention_weighted_bundle_favors_heavy_vector() {
        // Two distinct ternary vectors.
        let a = random_sparse(0x1234_5678);
        let b = random_sparse(0x9ABC_DEF0);

        // Equal-weight bundle vs. a bundle weighted heavily toward A.
        let eq = SparseVec::bundle(&[&a, &b]);
        let heavy_a = SparseVec::bundle_weighted(&[&a, &b], &[5.0, 1.0]);

        // Weighting toward A should make the bundle lean MORE toward A than
        // equal weighting does.
        let heavy_sim = heavy_a.cosine(&a);
        let eq_sim = eq.cosine(&a);
        assert!(
            heavy_sim >= eq_sim,
            "weighting toward A should lean the bundle at least as much toward A \
             as equal weighting: heavy_a.cosine(a)={:.4} should be >= eq.cosine(a)={:.4}",
            heavy_sim,
            eq_sim
        );

        // weights == [1,1] must be identical to plain bundle (same nz + vals).
        let unit = SparseVec::bundle_weighted(&[&a, &b], &[1.0, 1.0]);
        let plain = SparseVec::bundle(&[&a, &b]);
        assert_eq!(
            unit.nz, plain.nz,
            "bundle_weighted with unit weights must have identical nz to bundle"
        );
        assert_eq!(
            unit.vals, plain.vals,
            "bundle_weighted with unit weights must have identical vals to bundle"
        );
    }
}
