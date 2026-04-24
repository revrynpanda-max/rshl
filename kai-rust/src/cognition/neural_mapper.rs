//! Neural VSA Mapper — a small learned bridge from dense embeddings
//! (BitNet, BERT, sentence-transformers, …) into KAI's 16384-dim
//! sparse ternary lattice.
//!
//! ## Why this exists
//!
//! Dense transformer hidden states and sparse ternary VSA vectors are
//! *different encodings of the same meaning*. The **Hyperdimensional
//! Probe** paper (Bronzini et al., arXiv:2509.25045, 2025) shows that
//! a small learned linear probe can pull a transformer residual stream
//! into a VSA basis that preserves its binding / unbinding behavior —
//! you can read the LLM's internal state *as an HDC vector* and
//! operate on it with the same primitives we already have
//! (`bind`, `unbind`, `permute`, `superpose`).
//!
//! `NeuralVsaMapper` is exactly that bridge, dimensioned for our
//! system: a tiny 2-layer MLP that takes a frozen external dense
//! embedding and emits a 16384-dim ternary `SparseVec` at the same
//! 4 % density budget every other lattice vector uses.
//!
//! ## What this is NOT
//!
//! * It is **not** BitNet-as-a-black-box. The mapper is KAI-owned, its
//!   weights live on disk in our binary format, and every dimension of
//!   its output is interpretable in our existing VSA math.
//! * It is **not** a sentence encoder you train from scratch. The
//!   upstream dense model does the heavy lifting; this module just
//!   learns the projection into our ternary role-space.
//! * It is **not** required to run KAI. `build_generative_state` works
//!   without it. The mapper is an *optional* additional channel you
//!   can blend in when you have an external dense model hooked up.
//!
//! ## Architecture
//!
//! ```text
//!   dense (d_in)  ──► W1 x + b1  ──► GELU  ──► W2 h + b2  ──► logits (DIM)
//!     [frozen external features]    [trainable]              ──► top-4% ±1
//! ```
//!
//! * **Layer 1** (`d_in → d_hidden`, GELU-activated) is randomly
//!   initialized and *frozen by default*. It acts as a non-linear
//!   feature expander — a fixed projection that gives the probe a
//!   richer representation to fit without us having to backprop
//!   through a whole MLP in pure Rust.
//!
//! * **Layer 2** (`d_hidden → 16384`, linear) is **trainable**. This is
//!   "the probe" in the paper's sense: a linear map from frozen
//!   features into the VSA basis. We implement one-sample SGD on just
//!   this layer, which is tractable in pure Rust without an autograd
//!   framework.
//!
//! * **Sparsification**: we ternarize the output logits by picking the
//!   top-`0.04 · DIM` dimensions by absolute value and writing
//!   `sign(logit)` to them. Everything else stays zero. This keeps the
//!   output at the same 4 % density budget `SparseVec::encode`,
//!   `StatLexicon::encode_sentence`, and `build_generative_state` all
//!   emit, so the mapper composes cleanly with the rest of the system.
//!
//! ## How to train it
//!
//! See `NeuralVsaMapper::train_step` for the per-sample math. The
//! recipe:
//!
//!   1. Collect paired data `(dense_embedding, text)`.
//!      - `dense_embedding`: last-layer pooled hidden state from BitNet
//!        (or any frozen encoder), flattened to `Vec<f32>` of length
//!        `d_in`.
//!      - `text`: the same sentence the encoder was fed.
//!   2. For each pair, build the target: `target =
//!      lex.encode_sentence(text)` — the lattice's own canonical
//!      representation. (For a richer target, use
//!      `universe.encode_generative_state(text, lex, trace, field)`.)
//!   3. Call `mapper.train_step(&dense_embedding, &target)`; it returns
//!      the per-sample MSE loss and updates the output-layer weights
//!      in place.
//!   4. Repeat over the corpus until held-out cosine similarity between
//!      `mapper.map_to_sparse(&dense)` and `target` stabilizes above,
//!      say, 0.7.
//!   5. `mapper.save(path)` to freeze it.
//!
//! If you'd rather train offline in PyTorch, the layout of
//! `w1, b1, w2, b2` below is the exact set of tensors you need to
//! export and drop in via `load`. See the save/load section for the
//! on-disk format.
//!
//! ## Integration
//!
//! [`blend_mapper_with_state`] wraps the typical call site:
//!
//! ```ignore
//! let dense = bitnet_client.encode(prompt); // external
//! let state = universe.encode_generative_state(prompt, &lex, &trace, &field);
//! let fused = blend_mapper_with_state(&mapper, &dense, state, 1.5, 3.0);
//! let reply = lex.incremental_generate(fused, 32);
//! ```
//!
//! The blend is a `weighted_superpose` at the same 4 % density budget,
//! so the decoder downstream can't tell the output came from a hybrid
//! source — it just sees another well-formed latent.

use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::Path;

use crate::cognition::generative::weighted_superpose;
use crate::core::sparse_vec::{SparseVec, DIM};

// ─────────────────────────────────────────────────────────────────────
// Hyperparameters — tune these by editing constants, not at runtime,
// so a trained-mapper file on disk always matches the binary that
// saved it.
// ─────────────────────────────────────────────────────────────────────

/// Hidden width of the probe. Smaller = cheaper to train, less
/// Minimum useful hidden width for real LLM embeddings.
///
/// **Why 2048?**
/// Real embedding models (Mistral 7B, Llama 3, nomic-embed-text) produce
/// dense vectors of 4096 or 768 dimensions. At 512 the mapper imposes an
/// 8:1 compression before the output layer — the bottleneck collapses the
/// manifold and cosine similarity stays near 0.21 with every input mapping
/// to the same 2-3 tokens. 2048 gives a comfortable 2:1 ratio for 4096-dim
/// inputs and is still well within single-sample SGD budget (~134 M f32 for
/// W1 + W2 at d_in=4096 → ~512 MB, acceptable for a one-shot training run).
///
/// For stub/test training (`--stub-embedder`, d_in=384) this constant is
/// still used as the default but the mapper is mildly over-parameterised —
/// that's fine; stub runs are only for pipeline validation.
///
/// The `train_real` path overrides this with `max(2048, d_in / 2)` after
/// d_in is auto-discovered, so very large models (d_in=8192) get 4096.
pub const DEFAULT_D_HIDDEN: usize = 2048;

/// Default learning rate for the output-layer SGD. Matches common
/// linear-probe recipes (Alain & Bengio, 2016; Bronzini et al., 2025).
pub const DEFAULT_LEARNING_RATE: f32 = 5e-4;

/// On-disk file magic. Bumping this is how we signal a format change
/// if we ever switch to f16 weights or quantize.
const FILE_MAGIC: &[u8; 8] = b"KAIVSA01";

// ─────────────────────────────────────────────────────────────────────
// The mapper itself
// ─────────────────────────────────────────────────────────────────────

/// Small learned projection from a dense embedding (length `d_in`) to
/// a 16384-dim sparse ternary `SparseVec`.
///
/// Architecture is fully documented in the module header. The public
/// surface is intentionally tight — callers pick up a `NeuralVsaMapper`
/// from `new` / `load`, hand it a `&[f32]`, and get back a `SparseVec`
/// that composes with the rest of the lattice.
#[derive(Clone)]
pub struct NeuralVsaMapper {
    /// Dimensionality of the incoming dense embedding.
    pub d_in: usize,

    /// Width of the hidden layer.
    pub d_hidden: usize,

    /// Fraction of output dims that survive the top-K ternarization.
    /// Defaults to 0.04 to match the rest of RSHL.
    pub target_density: f32,

    /// SGD step size for `train_step`. Only the output layer is
    /// trained, so the lr only matters for `w2` and `b2`.
    pub learning_rate: f32,

    /// Layer 1: `d_hidden × d_in`, row-major. Frozen random init.
    w1: Vec<f32>,
    b1: Vec<f32>,

    /// Layer 2: `DIM × d_hidden`, row-major. Trainable.
    w2: Vec<f32>,
    b2: Vec<f32>,
}

impl NeuralVsaMapper {
    /// Build a fresh mapper with random Xavier-uniform init. The PRNG
    /// is seeded from `seed` so two mappers built with the same seed
    /// on the same dimensions are byte-identical — important for
    /// reproducible experiments and so a checkpoint saved right after
    /// construction can be diff-compared sanely.
    pub fn new(d_in: usize, d_hidden: usize, seed: u64) -> Self {
        assert!(d_in > 0, "d_in must be positive");
        assert!(d_hidden > 0, "d_hidden must be positive");

        let mut rng = XorShift32::new_from_u64(seed);

        // Xavier uniform limits: sqrt(6 / (fan_in + fan_out)).
        let l1_limit = (6.0 / (d_in + d_hidden) as f32).sqrt();
        let l2_limit = (6.0 / (d_hidden + DIM) as f32).sqrt();

        let w1: Vec<f32> = (0..d_hidden * d_in)
            .map(|_| rng.uniform_signed(l1_limit))
            .collect();
        let b1: Vec<f32> = vec![0.0; d_hidden];

        let w2: Vec<f32> = (0..DIM * d_hidden)
            .map(|_| rng.uniform_signed(l2_limit))
            .collect();
        let b2: Vec<f32> = vec![0.0; DIM];

        Self {
            d_in,
            d_hidden,
            target_density: 0.04,
            learning_rate: DEFAULT_LEARNING_RATE,
            w1,
            b1,
            w2,
            b2,
        }
    }

    /// Convenience: `new(d_in, DEFAULT_D_HIDDEN, fixed_seed)`. Use for
    /// quick prototyping; prefer `new` with a caller-chosen seed in
    /// production so the checkpoint history is auditable.
    pub fn new_untrained(d_in: usize) -> Self {
        Self::new(d_in, DEFAULT_D_HIDDEN, 0xC0FFEE_BABE)
    }

    // ── Forward pass ──────────────────────────────────────────────────

    /// Compute the frozen hidden layer: `h = GELU(W1 x + b1)`.
    ///
    /// Kept separate from `forward` so `train_step` can reuse the
    /// hidden activation for gradient computation without re-
    /// evaluating it. That saves ~half the flops per training step.
    fn forward_hidden(&self, x: &[f32]) -> Vec<f32> {
        assert_eq!(
            x.len(),
            self.d_in,
            "dense embedding length {} != d_in {}",
            x.len(),
            self.d_in
        );
        let mut h = vec![0.0f32; self.d_hidden];
        for i in 0..self.d_hidden {
            let row = &self.w1[i * self.d_in..(i + 1) * self.d_in];
            let mut s = self.b1[i];
            for k in 0..self.d_in {
                s += row[k] * x[k];
            }
            h[i] = gelu(s);
        }
        h
    }

    /// Full forward pass, returning the raw `DIM`-dim logits.
    ///
    /// Callers who only need the ternary output should use
    /// `map_to_sparse` — that's the normal path, and it avoids
    /// materializing the dense logits in the caller. Exposing
    /// `forward` by itself is useful for debugging the probe's
    /// distribution before sparsification.
    pub fn forward(&self, x: &[f32]) -> Vec<f32> {
        let h = self.forward_hidden(x);
        self.forward_output(&h)
    }

    /// Compute the output layer given a pre-computed hidden vector.
    fn forward_output(&self, h: &[f32]) -> Vec<f32> {
        let mut z = vec![0.0f32; DIM];
        for i in 0..DIM {
            let row = &self.w2[i * self.d_hidden..(i + 1) * self.d_hidden];
            let mut s = self.b2[i];
            for k in 0..self.d_hidden {
                s += row[k] * h[k];
            }
            z[i] = s;
        }
        z
    }

    /// **The point of this whole module.** Project a dense embedding
    /// straight into a 4 %-sparse ternary `SparseVec`.
    ///
    /// Procedure:
    ///
    ///   1. Run the full forward pass → `DIM` raw logits.
    ///   2. Pick the top `target_density · DIM` dimensions by
    ///      absolute value.
    ///   3. Write `+1` where that logit was positive, `-1` where it
    ///      was negative, `0` everywhere else.
    ///
    /// Output is guaranteed to be a valid `SparseVec` with at most
    /// `target_density · DIM` nonzero entries and values in
    /// `{-1, 0, +1}` — i.e. it composes with `bind`, `unbind`,
    /// `cosine`, `superpose_sparse`, and `find_nearest` the same way
    /// every other RSHL vector does.
    pub fn map_to_sparse(&self, dense_embedding: &[f32]) -> SparseVec {
        let logits = self.forward(dense_embedding);
        ternarize_top_k(&logits, self.target_density)
    }

    // ── Training ──────────────────────────────────────────────────────

    /// One-sample SGD step on the *output layer only* (`w2`, `b2`).
    ///
    /// Loss = ½ · Σᵢ (z₂ᵢ − tᵢ)²
    /// where `z₂` is the raw output logits and `t` is the target cast
    /// from ternary `{-1, 0, +1}` into f32.
    ///
    /// Gradients (closed form, no autograd needed):
    ///
    /// ```text
    ///   dL/dz₂[i]    = z₂[i] − t[i]
    ///   dL/dw2[i,j]  = dL/dz₂[i] · h[j]
    ///   dL/db2[i]    = dL/dz₂[i]
    /// ```
    ///
    /// SGD update:
    ///
    /// ```text
    ///   w2[i,j] -= lr · dL/dw2[i,j]
    ///   b2[i]   -= lr · dL/db2[i]
    /// ```
    ///
    /// `w1` / `b1` remain frozen, mirroring a standard linear probe
    /// on top of a frozen backbone.
    ///
    /// Returns the per-sample MSE (the loss value *before* the update,
    /// so a training loop can log convergence without a second forward
    /// pass).
    pub fn train_step(&mut self, dense_embedding: &[f32], target: &SparseVec) -> f32 {
        assert_eq!(
            target.data.len(),
            DIM,
            "target SparseVec length {} != DIM {}",
            target.data.len(),
            DIM
        );

        let h = self.forward_hidden(dense_embedding);
        let z = self.forward_output(&h);

        // Compute residual (dL/dz2) and accumulate loss in one pass.
        let mut residual = vec![0.0f32; DIM];
        let mut loss = 0.0f32;
        for i in 0..DIM {
            let t = target.data[i] as f32;
            let r = z[i] - t;
            residual[i] = r;
            loss += r * r;
        }
        loss *= 0.5;

        // SGD on w2 / b2. This is the hot loop — 16384 * 512 ≈ 8.4M
        // multiply-adds per step. Inline manually for the compiler.
        let lr = self.learning_rate;
        for i in 0..DIM {
            let r = residual[i];
            if r == 0.0 {
                continue;
            }
            let row_start = i * self.d_hidden;
            let row = &mut self.w2[row_start..row_start + self.d_hidden];
            let step = lr * r;
            for j in 0..self.d_hidden {
                row[j] -= step * h[j];
            }
            self.b2[i] -= step;
        }

        loss
    }

    /// Bulk-train over a slice of `(dense, target)` pairs for one
    /// epoch, returning the mean per-sample loss. Thin wrapper around
    /// `train_step` — offered mostly so the training harness doesn't
    /// have to reimplement the streaming loop.
    pub fn train_epoch(&mut self, pairs: &[(Vec<f32>, SparseVec)]) -> f32 {
        if pairs.is_empty() {
            return 0.0;
        }
        let mut total = 0.0f32;
        for (x, t) in pairs {
            total += self.train_step(x, t);
        }
        total / pairs.len() as f32
    }

    // ── Persistence ───────────────────────────────────────────────────
    //
    // Binary format, little-endian:
    //
    //   bytes  0..  8 : magic ("KAIVSA01")
    //   bytes  8.. 12 : d_in   (u32)
    //   bytes 12.. 16 : d_hidden (u32)
    //   bytes 16.. 20 : dim (u32, must equal DIM at load time)
    //   bytes 20.. 24 : target_density (f32)
    //   bytes 24.. 28 : learning_rate (f32)
    //   then, in order: w1, b1, w2, b2 as raw f32 LE.
    //
    // Chose raw binary over JSON because `w2` alone is already ≥32 MB
    // of floats; JSON would balloon to ~3× and slow loads to seconds.

    /// Save the mapper to disk in the compact binary format above.
    pub fn save<P: AsRef<Path>>(&self, path: P) -> std::io::Result<()> {
        let f = File::create(path)?;
        let mut w = BufWriter::new(f);
        w.write_all(FILE_MAGIC)?;
        w.write_all(&(self.d_in as u32).to_le_bytes())?;
        w.write_all(&(self.d_hidden as u32).to_le_bytes())?;
        w.write_all(&(DIM as u32).to_le_bytes())?;
        w.write_all(&self.target_density.to_le_bytes())?;
        w.write_all(&self.learning_rate.to_le_bytes())?;
        write_f32_slice(&mut w, &self.w1)?;
        write_f32_slice(&mut w, &self.b1)?;
        write_f32_slice(&mut w, &self.w2)?;
        write_f32_slice(&mut w, &self.b2)?;
        w.flush()?;
        Ok(())
    }

    /// Load a mapper previously saved with `save`. Errors if the file
    /// magic, the on-disk DIM, or any of the byte lengths don't match.
    pub fn load<P: AsRef<Path>>(path: P) -> std::io::Result<Self> {
        use std::io::ErrorKind;
        let f = File::open(path)?;
        let mut r = BufReader::new(f);

        let mut magic = [0u8; 8];
        r.read_exact(&mut magic)?;
        if &magic != FILE_MAGIC {
            return Err(std::io::Error::new(
                ErrorKind::InvalidData,
                "neural_mapper: bad magic (wrong file or format version)",
            ));
        }

        let d_in = read_u32(&mut r)? as usize;
        let d_hidden = read_u32(&mut r)? as usize;
        let dim_on_disk = read_u32(&mut r)? as usize;
        if dim_on_disk != DIM {
            return Err(std::io::Error::new(
                ErrorKind::InvalidData,
                format!(
                    "neural_mapper: DIM mismatch — file has {}, binary has {}",
                    dim_on_disk, DIM
                ),
            ));
        }
        let target_density = read_f32(&mut r)?;
        let learning_rate = read_f32(&mut r)?;

        let w1 = read_f32_vec(&mut r, d_hidden * d_in)?;
        let b1 = read_f32_vec(&mut r, d_hidden)?;
        let w2 = read_f32_vec(&mut r, DIM * d_hidden)?;
        let b2 = read_f32_vec(&mut r, DIM)?;

        Ok(Self {
            d_in,
            d_hidden,
            target_density,
            learning_rate,
            w1,
            b1,
            w2,
            b2,
        })
    }
}

// ─────────────────────────────────────────────────────────────────────
// Integration helper
// ─────────────────────────────────────────────────────────────────────

/// Blend the mapper's output into an existing generative state at a
/// chosen weight ratio, producing a single 4 %-sparse `SparseVec`
/// the decoder can consume directly.
///
/// Typical call site (right before `incremental_generate`):
///
/// ```ignore
/// let state = universe.encode_generative_state(prompt, &lex, &trace, &field);
/// let fused = blend_mapper_with_state(
///     &mapper,
///     &dense_embedding_from_bitnet,
///     state,
///     /* mapper_weight = */ 1.5,
///     /* state_weight  = */ 3.0,
/// );
/// let out = lex.incremental_generate(fused, 32);
/// ```
///
/// The state weight is deliberately higher than the mapper weight so
/// the prompt/memory/field channels keep dominant control; the mapper
/// acts as a re-weighting signal, not a replacement. Adjust the ratio
/// as you validate the probe on real paired data.
pub fn blend_mapper_with_state(
    mapper: &NeuralVsaMapper,
    dense_embedding: &[f32],
    state: SparseVec,
    mapper_weight: f32,
    state_weight: f32,
) -> SparseVec {
    let mapped = mapper.map_to_sparse(dense_embedding);
    weighted_superpose(
        &[(&state, state_weight), (&mapped, mapper_weight)],
        mapper.target_density,
    )
}

// ─────────────────────────────────────────────────────────────────────
// Internal numerics
// ─────────────────────────────────────────────────────────────────────

/// Fast GELU (OpenAI tanh-approximation). Matches the variant used in
/// most modern transformer implementations within < 1e-4.
#[inline]
fn gelu(x: f32) -> f32 {
    const SQRT_2_OVER_PI: f32 = 0.7978845608028654;
    const K: f32 = 0.044715;
    let t = SQRT_2_OVER_PI * (x + K * x * x * x);
    0.5 * x * (1.0 + t.tanh())
}

/// Keep the top `density · DIM` entries of `logits` by absolute value,
/// writing `±1` per entry. Everything else → 0. Mirrors the
/// ternarization step inside `SparseVec::encode` and the generative
/// encoder's `weighted_superpose`.
pub(crate) fn ternarize_top_k(logits: &[f32], density: f32) -> SparseVec {
    assert_eq!(
        logits.len(),
        DIM,
        "ternarize_top_k expects DIM-length logits"
    );
    let target_count = ((DIM as f32) * density) as usize;
    if target_count == 0 {
        return SparseVec::zero();
    }

    // Explicit top-N selection (same approach as generative::weighted_superpose).
    let mut indexed: Vec<(usize, f32)> = logits
        .iter()
        .enumerate()
        .filter(|(_, v)| v.abs() > 0.0)
        .map(|(i, v)| (i, v.abs()))
        .collect();
    indexed.sort_unstable_by(|a, b| {
        b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal)
    });
    indexed.truncate(target_count);

    let mut out = SparseVec::zero();
    for (i, _) in indexed {
        out.data[i] = if logits[i] > 0.0 { 1 } else { -1 };
    }
    out
}

/// Tiny deterministic PRNG. Same XorShift32 pattern as the rest of
/// the lattice — keeps mapper init reproducible without pulling in a
/// `rand` dependency.
struct XorShift32 {
    s: u32,
}

impl XorShift32 {
    fn new_from_u64(seed: u64) -> Self {
        // Fold the u64 into u32 without losing entropy from the high
        // bits, then force nonzero to avoid XorShift's zero fixed
        // point.
        let mixed = (seed ^ (seed >> 32)) as u32;
        let s = if mixed == 0 { 0x9E3779B9 } else { mixed };
        Self { s }
    }

    fn next_u32(&mut self) -> u32 {
        let mut x = self.s;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.s = x;
        x
    }

    /// Uniform sample in `[-limit, +limit]`.
    fn uniform_signed(&mut self, limit: f32) -> f32 {
        // Take 24 bits (single-precision mantissa) for best float
        // coverage; rescale to [-1, +1] then by `limit`.
        let bits = self.next_u32() >> 8; // 24 bits
        let unit = (bits as f32) / ((1u32 << 24) as f32); // [0, 1)
        (unit * 2.0 - 1.0) * limit
    }
}

// ── Binary I/O helpers ──────────────────────────────────────────────

fn write_f32_slice<W: Write>(w: &mut W, xs: &[f32]) -> std::io::Result<()> {
    // Writing in 1024-float (4 KB) chunks keeps BufWriter happy and
    // avoids per-element syscall overhead even if the BufWriter cap
    // is small. Still ~8K iterations for W2, negligible.
    let mut buf = [0u8; 4096];
    let mut i = 0;
    while i < xs.len() {
        let end = (i + 1024).min(xs.len());
        let mut bi = 0;
        for &v in &xs[i..end] {
            buf[bi..bi + 4].copy_from_slice(&v.to_le_bytes());
            bi += 4;
        }
        w.write_all(&buf[..bi])?;
        i = end;
    }
    Ok(())
}

fn read_u32<R: Read>(r: &mut R) -> std::io::Result<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
}

fn read_f32<R: Read>(r: &mut R) -> std::io::Result<f32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b)?;
    Ok(f32::from_le_bytes(b))
}

fn read_f32_vec<R: Read>(r: &mut R, n: usize) -> std::io::Result<Vec<f32>> {
    let mut out = Vec::with_capacity(n);
    let mut buf = [0u8; 4096];
    let mut remaining = n;
    while remaining > 0 {
        let want = remaining.min(buf.len() / 4);
        r.read_exact(&mut buf[..want * 4])?;
        for k in 0..want {
            out.push(f32::from_le_bytes([
                buf[k * 4],
                buf[k * 4 + 1],
                buf[k * 4 + 2],
                buf[k * 4 + 3],
            ]));
        }
        remaining -= want;
    }
    Ok(out)
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::sparse_vec::DIM;

    #[test]
    fn forward_returns_dim_logits() {
        // Use a small hidden width so the test is fast even in debug.
        let mapper = NeuralVsaMapper::new(16, 8, 0xDEAD_BEEF);
        let x = vec![0.1f32; 16];
        let z = mapper.forward(&x);
        assert_eq!(z.len(), DIM);
        assert!(z.iter().all(|v| v.is_finite()), "no NaN/Inf in logits");
    }

    #[test]
    fn map_to_sparse_respects_density_and_is_ternary() {
        let mapper = NeuralVsaMapper::new(32, 16, 0xA11CE);
        let x: Vec<f32> = (0..32).map(|i| (i as f32) * 0.03 - 0.5).collect();
        let v = mapper.map_to_sparse(&x);

        assert_eq!(v.data.len(), DIM);
        // Every entry in {-1, 0, +1}.
        assert!(v.data.iter().all(|&b| b == -1 || b == 0 || b == 1));

        let target = ((DIM as f32) * mapper.target_density) as usize;
        let slack = (target as f32 * 0.05) as usize;
        let nnz = v.nnz();
        assert!(
            nnz + slack >= target && nnz <= target + slack,
            "density should hit target budget, got nnz={} target={} slack={}",
            nnz,
            target,
            slack
        );
    }

    #[test]
    fn training_reduces_loss_on_fixed_example() {
        // Overfit a single (x, target) pair — SGD on the output layer
        // must monotonically reduce MSE. This is the smoke test that
        // gradients point the right direction.
        let mut mapper = NeuralVsaMapper::new(8, 8, 0x1234_5678);
        mapper.learning_rate = 1e-3;

        let x = vec![0.2f32; 8];
        // Target = a stable, non-trivial SparseVec.
        let target = SparseVec::encode("a fixed target for the probe to fit onto");

        let l0 = {
            let z = mapper.forward(&x);
            let mut s = 0.0f32;
            for i in 0..DIM {
                let r = z[i] - (target.data[i] as f32);
                s += r * r;
            }
            0.5 * s
        };

        let mut l_last = l0;
        for _ in 0..30 {
            l_last = mapper.train_step(&x, &target);
        }

        // We expect at least a meaningful fraction of loss reduction.
        assert!(
            l_last < l0 * 0.95,
            "loss should decrease under SGD, l0={} l_last={}",
            l0,
            l_last
        );
    }

    #[test]
    fn save_and_load_roundtrip() {
        let tmp = std::env::temp_dir().join("kai_vsa_mapper_roundtrip.bin");
        // Small dims so the test file is tiny and fast.
        let mapper = NeuralVsaMapper::new(4, 4, 0xF00D);
        mapper.save(&tmp).expect("save");
        let loaded = NeuralVsaMapper::load(&tmp).expect("load");

        assert_eq!(mapper.d_in, loaded.d_in);
        assert_eq!(mapper.d_hidden, loaded.d_hidden);
        assert_eq!(mapper.target_density, loaded.target_density);
        assert_eq!(mapper.learning_rate, loaded.learning_rate);
        assert_eq!(mapper.w1, loaded.w1);
        assert_eq!(mapper.b1, loaded.b1);
        assert_eq!(mapper.w2, loaded.w2);
        assert_eq!(mapper.b2, loaded.b2);

        // Forward pass must produce identical logits after roundtrip.
        let x = vec![0.25f32, -0.1, 0.7, -0.3];
        let a = mapper.forward(&x);
        let b = loaded.forward(&x);
        assert_eq!(a.len(), b.len());
        for (lhs, rhs) in a.iter().zip(b.iter()) {
            assert!((lhs - rhs).abs() < 1e-6, "logits drifted across save/load");
        }

        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn blend_mapper_with_state_is_sparse_and_ternary() {
        // The blend path: given any state and any mapper output, the
        // result must still be a valid 4%-density ternary SparseVec
        // the decoder can consume.
        let mapper = NeuralVsaMapper::new(4, 4, 0xBEEF);
        let dense = vec![0.1f32, -0.3, 0.7, -0.5];
        let state = SparseVec::encode("some backbone content for the blend");

        let fused = blend_mapper_with_state(&mapper, &dense, state.clone(), 1.0, 3.0);
        assert_eq!(fused.data.len(), DIM);
        assert!(fused.data.iter().all(|&b| b == -1 || b == 0 || b == 1));

        let target = ((DIM as f32) * mapper.target_density) as usize;
        let slack = (target as f32 * 0.05) as usize;
        let nnz = fused.nnz();
        assert!(
            nnz + slack >= target && nnz <= target + slack,
            "blended density off budget: nnz={} target={}",
            nnz,
            target
        );

        // Heavy weight on `state` should make `fused` resemble `state`
        // more than any random vector.
        let sim_state = fused.cosine(&state);
        let rand = SparseVec::encode("unrelated noise words totally different");
        let sim_rand = fused.cosine(&rand);
        assert!(
            sim_state > sim_rand,
            "state-heavy blend should resemble the state (state={:.4}, rand={:.4})",
            sim_state,
            sim_rand
        );
    }

    #[test]
    fn gelu_zero_and_extremes() {
        assert!((gelu(0.0)).abs() < 1e-6);
        assert!(gelu(5.0) > 4.99 && gelu(5.0) < 5.01);
        assert!(gelu(-5.0) > -0.01 && gelu(-5.0) < 0.0);
    }
}

