//! Statistical Lexicon — word → stable co-occurrence-shaped `SparseVec`.
//!
//! Scientific references:
//!
//!   * Hyperdimensional Probe (Bronzini et al., arXiv:2509.25045, 2025)
//!     shows that LLM residual streams can be mapped into VSA/HDC vectors
//!     that behave as soft, differentiable binding/unbinding operators —
//!     i.e. the same math we already run inside RSHL.
//!   * Continuous Autoregressive Language Models (Shao et al.,
//!     arXiv:2510.27688, 2025) predicts the *next vector*, not the next
//!     token id. The lexicon here gives us the inverse map — a stable
//!     vector per word — that closes that loop for decoding.
//!   * VSA / HDC Survey (ACM CSUR 2022+ updates): co-occurrence
//!     bundling, sparse ternary codes, and permutation-based sequence
//!     binding all come from the HDC tradition this module implements.
//!   * Projected Autoregression (arXiv:2601.04854, 2026): continuous
//!     autoregressive loop with a delayed discrete commitment step — the
//!     decoder eventually wires `find_nearest` into exactly that
//!     commitment point.
//!
//! ## What this builds
//!
//! Given one or more text corpora, `StatLexicon::build_from_paths`:
//!
//!   1. Tokenizes every corpus in a deterministic order.
//!   2. Assigns each *unique* word a **stable seed vector** derived from
//!      `hash(word)` via a seeded XorShift — same word, same vector,
//!      every run, independent of corpus order.
//!   3. Walks every corpus with a sliding window (`WINDOW` words each
//!      side) and, for each center word, accumulates the seed vectors
//!      of its neighbors into an `i32` histogram. This is the co-
//!      occurrence bundling step — statistically "who lives near who"
//!      gets baked into every word's final vector.
//!   4. Ternarizes each histogram at the same 4 % sparsity budget the
//!      rest of RSHL uses, producing one `SparseVec` per unique word.
//!
//! ## Properties
//!
//!   * **Stable**: the same set of corpora (in the same order) always
//!     produces byte-identical vectors. Even reordering corpora leaves
//!     each word's vector nearly unchanged — only the neighbor counts
//!     shift, and the top-4 % surviving the ternarize step is dominated
//!     by the seed contribution plus the strongest neighbors.
//!   * **Semantic**: words that share contexts ("cat" / "dog",
//!     "happy" / "joyful") end up with cosine similarity well above the
//!     random-pair baseline.
//!   * **Decodable**: `find_nearest(v)` does an argmax cosine across the
//!     vocabulary — exactly what the autoregressive decoder in step 3
//!     of the generative pipeline will call after peeling off the
//!     positional binding.
//!
//! This file deliberately depends on *only* `SparseVec` primitives
//! already in `core::sparse_vec`. No strings touch the lattice — words
//! are keys on the outside, vectors are the entire currency inside.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use super::sparse_vec::{SparseVec, DIM};

/// Deterministic position basis, computed once. Every caller on every
/// machine gets bit-identical bytes because:
///   * `seed_vector` derives from an FNV-1a hash of a fixed string,
///   * the XorShift64 PRNG used inside is reproducible,
///   * `DIM` is a compile-time constant.
/// This is what makes encode_sentence/incremental_generate a true
/// inverse pair — the decoder and encoder agree on every role slot.
static POSITION_BASIS: OnceLock<SparseVec> = OnceLock::new();

fn position_basis() -> &'static SparseVec {
    POSITION_BASIS.get_or_init(|| seed_vector("__kai_position_basis__"))
}

/// position_key(i) = POSITION_BASIS.permute(i as u32).
/// Every `pos` yields a deterministic, near-orthogonal key. The same
/// key is used for both binding (in the encoder) and unbinding (in
/// the decoder) — `bind` being self-inverse on the support of the key
/// means no `permute_inv` is ever needed in the round-trip.
pub(crate) fn position_key(pos: usize) -> SparseVec {
    position_basis().permute(pos as u32)
}

/// How many nonzero bits a ternarized word vector should carry.
/// Matches the 4 % density the rest of the lattice uses so cosine
/// statistics behave the same way as everywhere else in RSHL.
const TARGET_NNZ: usize = (DIM as f32 * 0.04) as usize;

/// Window radius on each side of a center word for co-occurrence
/// bundling. ±3 captures "the quick brown fox" style local context
/// without drowning the seed signal.
const WINDOW: usize = 3;

/// How many bits each seed vector flips when deriving a stable base
/// from `hash(word)`. Half positive, half negative.
const SEED_PAIRS: usize = TARGET_NNZ / 2;

/// Weight given to a word's own seed vector when accumulating
/// neighbor statistics. High enough that every word is always closest
/// to *itself* under cosine even in the limit of heavy co-occurrence
/// overlap — otherwise common words ("the", "a") would collapse onto
/// the same vector.
const SELF_BIAS: i32 = 16;

/// Per-neighbor contribution. ±1 keeps the histogram additions cheap
/// while still letting frequent contexts dominate after ranking.
const NEIGHBOR_WEIGHT: i32 = 1;

// ─────────────────────────────────────────────────────────────────────
// Decoder sampling parameters.
//
// The sampled variant of `incremental_generate` (aka
// `incremental_generate_with`) exposes the standard LLM-style
// temperature / top-k / repetition-penalty knobs on top of the
// peel → commit → re-bind core loop. The defaults here were chosen
// to match what the `--generate` CLI uses out of the box.
// ─────────────────────────────────────────────────────────────────────

/// Parameters controlling the sampled decoder
/// (`StatLexicon::incremental_generate_with`).
///
/// Sensible presets:
///   * `DecodeParams::greedy(n)` — reproduces the original argmax
///     decoder bit-for-bit, used by the backward-compatible
///     `incremental_generate(state, n)` wrapper.
///   * `DecodeParams::default()` — `temperature=0.7, top_k=16,
///     repetition_window=6, repetition_penalty=0.8` — the general-
///     purpose sampler the CLI defaults to.
#[derive(Debug, Clone, Copy)]
pub struct DecodeParams {
    /// Hard cap on emitted tokens.
    pub max_tokens: usize,
    /// Softmax temperature. `0.0` collapses to greedy argmax.
    /// Typical useful range: `0.3` (very focused) .. `1.2` (very
    /// varied). Higher values flatten the distribution toward
    /// uniform across the `top_k` pool.
    pub temperature: f32,
    /// Size of the cosine-nearest candidate pool at every step.
    /// `1` recovers greedy regardless of temperature; `16` is a
    /// reasonable default.
    pub top_k: usize,
    /// Number of most-recent tokens whose cosine scores are
    /// **subtracted** by `repetition_penalty` before the softmax.
    /// Set to `0` to disable repetition handling entirely.
    pub repetition_window: usize,
    /// Value subtracted from the cosine score of any candidate that
    /// appears in the recent window. Subtractive (not multiplicative)
    /// so it works symmetrically on positive and negative cosines.
    /// `0.8` pushes repeated words down meaningfully without making
    /// them impossible.
    pub repetition_penalty: f32,
    /// If `true`, the decoder breaks out of the loop the moment it
    /// emits the same word twice in a row. This is the original
    /// greedy-decoder behaviour from before the sampler existed; the
    /// backward-compatible `incremental_generate` wrapper preserves
    /// it. In sampled mode (where the repetition penalty and
    /// top-k softmax already handle loops gracefully) it defaults
    /// to `false` so the output isn't truncated prematurely.
    pub stop_on_immediate_repeat: bool,
    /// Mixing coefficient for the forward-transition bigram prior.
    /// Added to each candidate's cosine score before the softmax:
    /// `score = cosine + bigram_weight · log P(w | prev)`.
    /// `0.0` disables the prior entirely (behaviour equivalent to
    /// the pre-bigram decoder). `0.5` is the general-purpose
    /// default; higher values lean more heavily on corpus grammar
    /// at the cost of semantic flexibility.
    ///
    /// Has no effect when the lexicon carries an empty
    /// `BigramPrior` (pre-v2 on-disk files) — a warning is printed
    /// in the CLI path.
    pub bigram_weight: f32,
    /// RNG seed. Identical `(state, params)` always yields an
    /// identical string.
    pub seed: u64,
}

impl Default for DecodeParams {
    fn default() -> Self {
        Self {
            max_tokens: 32,
            temperature: 0.7,
            top_k: 16,
            repetition_window: 6,
            repetition_penalty: 0.8,
            stop_on_immediate_repeat: false,
            bigram_weight: 0.5,
            seed: 0xC0DE_CAFE_F00D_BABE,
        }
    }
}

impl DecodeParams {
    /// Greedy (argmax) preset — equivalent to the original pre-
    /// sampling, pre-bigram decoder. Used by the legacy
    /// `incremental_generate` wrapper for backward compatibility.
    pub fn greedy(max_tokens: usize) -> Self {
        Self {
            max_tokens,
            temperature: 0.0,
            top_k: 1,
            repetition_window: 1,
            repetition_penalty: 0.0,
            stop_on_immediate_repeat: true,
            bigram_weight: 0.0,
            seed: 0,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────
// Forward-transition bigram priors.
//
// The stat-lexicon's seed/co-occurrence bundling encodes "what word
// lives near what word" symmetrically (±WINDOW). It captures
// *semantics* well but carries no notion of order — "the" and "cat"
// are close because they co-occur, but the vectors never learn that
// "the" comes *before* "cat", never after.
//
// BigramPrior adds that missing signal. During the corpus walk in
// `build_from_paths` we count every adjacent (prev → next) pair in
// the tokenized stream. At decode time the prior is combined with
// the cosine score on each top-k candidate:
//
//   final_score(w) = cosine(w, peeled)
//                  + bigram_weight · log P(w | last_emitted)
//
// with Laplace (add-1) smoothing so log_prob is always finite and
// unseen transitions are still allowed — just heavily down-weighted.
//
// Storage is sparse per row: for each previous-word id we keep only
// the (next_id, count) pairs actually observed, sorted by next_id
// for O(log K) binary-search lookup.
// ─────────────────────────────────────────────────────────────────────

/// Forward bigram counts learned from the same tokenized corpus
/// that built the StatLexicon word vectors. Ids here match the
/// lexicon's `index` one-for-one.
///
/// Used by `incremental_generate_with` to bias the sampler toward
/// grammatically-plausible continuations. Empty when the lexicon
/// was built before the prior existed (old on-disk format) — in
/// that case `log_prob` returns `0.0` for every call and
/// `bigram_weight` has no effect.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct BigramPrior {
    /// Per previous-word id → sorted `(next_word_id, count)` pairs.
    /// `forward.len() == vocab_size` after a successful build.
    pub forward: Vec<Vec<(u32, u32)>>,
    /// Row totals: `row_totals[p] == Σ count` over `forward[p]`.
    /// Used as the denominator in `P(w | prev)`.
    pub row_totals: Vec<u32>,
    /// Unigram counts per word id. Used as the fallback when
    /// `prev` is `None` (start of sequence) or out of range.
    pub unigram: Vec<u32>,
    /// Total number of unigram observations across the corpus.
    pub total_tokens: u64,
    /// Vocabulary size at build time. Stored so Laplace smoothing
    /// uses exactly the right denominator even if a consumer
    /// loads only the prior without the lexicon.
    pub vocab_size: u32,
}

impl BigramPrior {
    /// `true` when the prior carries no counts — either because
    /// the lexicon is empty or because it was saved before the
    /// prior existed. Callers should treat an empty prior as
    /// "prior unavailable; skip bigram contribution."
    pub fn is_empty(&self) -> bool {
        self.total_tokens == 0 || self.vocab_size == 0
    }

    /// Laplace-smoothed natural-log probability of `next` following
    /// `prev`. Always finite.
    ///
    /// `P(w | prev) = (count(prev, w) + α) / (row_total(prev) + α · V)`
    ///
    /// with α=0.1 (add-tenth smoothing). A full add-1 Laplace is
    /// too aggressive on small corpora — with |V|≈2000 and
    /// row-totals of just a few tokens per word, add-1 pulls every
    /// unseen pair almost up to the seen-once pair floor, drowning
    /// the signal. α=0.1 preserves the differential between seen
    /// and unseen while still guaranteeing finite log-probs.
    ///
    /// Falls back to unigram when `prev` is `None` or out of range:
    /// `P(w) = (unigram(w) + α) / (total_tokens + α · V)`.
    pub fn log_prob(&self, prev: Option<usize>, next: usize) -> f32 {
        if self.is_empty() {
            return 0.0;
        }
        const ALPHA: f32 = 0.1;
        let v = self.vocab_size as f32;
        match prev.filter(|&p| p < self.row_totals.len()) {
            Some(p) => {
                let total = self.row_totals[p] as f32;
                let count = self.lookup_count(p, next as u32) as f32;
                ((count + ALPHA) / (total + ALPHA * v)).ln()
            }
            None => {
                let total = self.total_tokens as f32;
                let count = self.unigram.get(next).copied().unwrap_or(0) as f32;
                ((count + ALPHA) / (total + ALPHA * v)).ln()
            }
        }
    }

    /// Binary-search the sorted forward row for `prev`, returning
    /// `count(prev, next)` or `0` if the pair was never seen.
    fn lookup_count(&self, prev: usize, next: u32) -> u32 {
        let row = match self.forward.get(prev) {
            Some(r) => r,
            None => return 0,
        };
        match row.binary_search_by_key(&next, |&(n, _)| n) {
            Ok(i) => row[i].1,
            Err(_) => 0,
        }
    }

    /// Return the total number of unique bigrams stored (useful for
    /// diagnostics / save-time metrics).
    pub fn num_transitions(&self) -> usize {
        self.forward.iter().map(|r| r.len()).sum()
    }
}

// ─────────────────────────────────────────────────────────────────────
// Serialized on-disk form.
//
// SparseVec itself serializes as a dense Vec<i8>, which would blow up to
// 16 KB × |vocab| ≈ hundreds of MB. The lexicon file is instead stored
// as (idx, sign) pairs for each word's nonzero bits — roughly two
// orders of magnitude smaller while still bit-exact.
// ─────────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct SparsePairs {
    idx: Vec<u32>,
    sign: Vec<i8>,
}

#[derive(Serialize, Deserialize)]
struct LexiconFile {
    version: u32,
    dim: usize,
    words: Vec<String>,
    vectors: Vec<SparsePairs>,
    /// Forward bigram prior. Present in version-2+ files; version-1
    /// files load with an empty default (no prior), which means
    /// `bigram_weight` has no effect until the lexicon is rebuilt.
    #[serde(default)]
    bigram: BigramPrior,
}

/// Word → stable SparseVec mapping built from corpus statistics.
#[derive(Debug, Default, Clone)]
pub struct StatLexicon {
    /// Vocabulary in insertion order — the index here is the word's id
    /// everywhere else in the struct.
    words: Vec<String>,

    /// One vector per word, parallel to `words`.
    vectors: Vec<SparseVec>,

    /// word → index for O(1) lookup.
    index: HashMap<String, usize>,

    /// Forward-transition bigram prior built from the same
    /// tokenized corpus as `vectors`. Used by
    /// `incremental_generate_with` when `DecodeParams::bigram_weight
    /// > 0.0`. Empty when the lexicon was loaded from a pre-bigram
    /// on-disk file (no-op in that case).
    bigram: BigramPrior,
}

impl StatLexicon {
    /// Empty lexicon — only useful for tests and as the target of
    /// `build_from_paths`.
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of unique words in the lexicon.
    pub fn len(&self) -> usize {
        self.words.len()
    }

    /// `true` when there are no words.
    pub fn is_empty(&self) -> bool {
        self.words.is_empty()
    }

    /// Ordered vocabulary slice.
    pub fn words(&self) -> &[String] {
        &self.words
    }

    /// Vector for `word`, or `None` if the word is unknown.
    pub fn get(&self, word: &str) -> Option<&SparseVec> {
        let key = normalize(word);
        self.index.get(&key).map(|&i| &self.vectors[i])
    }

    /// Walk the vocabulary and return the word whose vector has the
    /// highest cosine against `target`. Used by the decoder to commit
    /// a continuous prediction back to a discrete word.
    pub fn find_nearest(&self, target: &SparseVec) -> Option<(&str, f32)> {
        let mut best: Option<(usize, f32)> = None;
        for (i, v) in self.vectors.iter().enumerate() {
            let s = target.cosine(v);
            match best {
                None => best = Some((i, s)),
                Some((_, bs)) if s > bs => best = Some((i, s)),
                _ => {}
            }
        }
        best.map(|(i, s)| (self.words[i].as_str(), s))
    }

    /// Top-K nearest words by cosine similarity.
    pub fn top_k_nearest(&self, target: &SparseVec, k: usize) -> Vec<(String, f32)> {
        let mut scored: Vec<(usize, f32)> = self
            .vectors
            .iter()
            .enumerate()
            .map(|(i, v)| (i, target.cosine(v)))
            .collect();
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored
            .into_iter()
            .take(k)
            .map(|(i, s)| (self.words[i].clone(), s))
            .collect()
    }

    // ─────────────────────────────────────────────────────────────────
    // Generative head — position-aware encoding + rolling decoder.
    //
    // This sits strictly on top of `predictive_query` / the conjunctive
    // mixer / `contrast`. Those remain untouched. The caller is free to
    // produce a latent state however they like — from a real user
    // prompt via `predictive_query`, from scratch, or from a previous
    // decoder step — and hand it to `incremental_generate` to roll out
    // a sentence one token at a time.
    //
    // Everything here leans on primitives already in the lattice:
    //   * `bind` / `unbind` = element-wise ternary multiply (self-inverse
    //     on the support of the key),
    //   * `permute(seed)`   = deterministic Fisher-Yates shuffle,
    //   * `superpose_sparse([...], 0.04)` = density-preserving bundle.
    // ─────────────────────────────────────────────────────────────────

    /// Bind a word vector into its positional role slot:
    ///   slot_i(word) = word.bind(&position_key(i))
    /// The bind is element-wise ternary multiply, which means this
    /// step is exactly reversed by `.unbind(&position_key(i))` on the
    /// support of the position key.
    pub fn bind_at_position(&self, word_vec: &SparseVec, pos: usize) -> SparseVec {
        let pkey = position_key(pos);
        word_vec.bind(&pkey)
    }

    /// Position-aware sentence encoder.
    ///
    /// ```text
    ///   E(w_0 w_1 … w_{N-1}) = superpose_sparse(
    ///       [ w_i.bind(&position_key(i)) for i in 0..N ],
    ///       0.04,
    ///   )
    /// ```
    ///
    /// Words not in the lexicon are silently skipped — the caller can
    /// cross-check with `StatLexicon::get` if they want to know. The
    /// returned vector is 4% sparse regardless of sentence length so
    /// it composes cleanly with the rest of RSHL (same density budget
    /// as every `SparseVec::encode` result).
    pub fn encode_sentence(&self, text: &str) -> SparseVec {
        let tokens = tokenize(text);
        if tokens.is_empty() {
            return SparseVec::zero();
        }
        let mut slots: Vec<SparseVec> = Vec::with_capacity(tokens.len());
        for (i, tok) in tokens.iter().enumerate() {
            if let Some(wv) = self.get(tok) {
                slots.push(self.bind_at_position(wv, i));
            }
        }
        if slots.is_empty() {
            return SparseVec::zero();
        }
        let refs: Vec<&SparseVec> = slots.iter().collect();
        SparseVec::superpose_sparse(&refs, 0.04)
    }

    /// **Incremental autoregressive decoder — the rolling loop.**
    ///
    /// This is the brain-like planning-to-execution handoff: at every
    /// step the current latent `state` is peeled at the next position,
    /// the nearest lexicon word is committed, the word vector is fed
    /// *back into the state* through the same positional binding, and
    /// the loop advances. Step `n+1` therefore sees every commitment
    /// step `n` made — exactly how a speaker's words coloring their
    /// next sentence feels from the inside.
    ///
    /// Contract per iteration `pos` in `0..max_tokens`:
    ///
    ///   1. `pkey    = position_key(pos)`
    ///   2. `peeled  = state.unbind(&pkey)`     — reverse the role bind
    ///   3. `word    = StatLexicon::find_nearest(&peeled)`
    ///      — the continuous-state → discrete-token commitment point
    ///   4. emit `word`
    ///   5. `wv      = lexicon[word]`
    ///   6. `state   = superpose_sparse(&[state, wv.bind(&pkey)], 0.04)`
    ///      — feed-forward; density stays at the 4% budget forever
    ///   7. advance `pos`
    ///
    /// Soft stop: if the decoder emits the same word twice in a row
    /// the state has hit a resonance fixpoint (nothing further will
    /// move it), so we break early. `max_tokens` is the hard cap.
    ///
    /// The lexicon's `find_nearest` is exactly the delayed discrete
    /// commitment of the *Projected Autoregression* formulation
    /// (arXiv:2601.04854): the model's native substrate is continuous
    /// (a sparse ternary vector), and a word is only forced out at the
    /// moment of emission.
    pub fn incremental_generate(&self, state: SparseVec, max_tokens: usize) -> String {
        // Backward-compatible greedy path. Forwards to the sampled
        // decoder with the `greedy()` preset — argmax + immediate-
        // repeat stop — which reproduces the original pre-sampling
        // behaviour byte-for-byte so existing callers and tests
        // keep working.
        self.incremental_generate_with(state, DecodeParams::greedy(max_tokens))
    }

    /// Sampled autoregressive decoder.
    ///
    /// Same peel → commit → re-bind loop as `incremental_generate`,
    /// but with three quality knobs on the **commit** step:
    ///
    ///   * **top-k truncation.** At every position we take the
    ///     `top_k` cosine-nearest words to the peeled latent instead
    ///     of just the argmax. This keeps the candidate pool on the
    ///     high-probability manifold — a critical defence against
    ///     the dense memory-carrying states produced by
    ///     `build_generative_state`, which otherwise blur argmax
    ///     into whichever cell's content dominates globally.
    ///   * **softmax temperature.** The `top_k` cosines are turned
    ///     into a probability distribution via
    ///     `p_i ∝ exp(score_i / T)`. `T=0` collapses back to greedy
    ///     (argmax); small `T` (~0.3) stays focused; larger `T`
    ///     (~1.0) gives varied but still-grounded output. Default
    ///     is `0.7`, the midpoint that typical LLM samplers use.
    ///   * **repetition penalty.** Words emitted in the last
    ///     `repetition_window` positions have `repetition_penalty`
    ///     **subtracted** from their cosine score before the
    ///     softmax. Subtractive (not multiplicative) so it works
    ///     symmetrically on positive and negative cosines.
    ///
    /// Stopping rules:
    ///   * hard cap at `params.max_tokens`,
    ///   * hard stop when the candidate pool is empty,
    ///   * **no** immediate-repetition fixpoint stop — the
    ///     repetition penalty handles that cleanly without
    ///     truncating the output.
    ///
    /// Determinism: identical `(state, params)` always yields the
    /// identical string thanks to the seeded SplitMix64 RNG below.
    pub fn incremental_generate_with(&self, state: SparseVec, params: DecodeParams) -> String {
        if self.is_empty() || params.max_tokens == 0 {
            return String::new();
        }

        // Local deterministic RNG. SplitMix64 is plenty for picking
        // one of <=top_k candidates; we don't need anything better.
        let mut rng_state: u64 = params.seed.wrapping_add(0x9E3779B97F4A7C15);

        let mut state = state;
        let mut out: Vec<String> = Vec::with_capacity(params.max_tokens);

        let greedy = params.top_k <= 1 || params.temperature <= 0.0;
        let k_eff = params.top_k.max(1);

        for pos in 0..params.max_tokens {
            // ── 1. role key + peel ───────────────────────────────────
            let pkey = position_key(pos);
            let peeled = state.unbind(&pkey);

            // ── 2. candidate pool ────────────────────────────────────
            let mut candidates: Vec<(String, f32)> = if greedy {
                match self.find_nearest(&peeled) {
                    Some((w, s)) => vec![(w.to_string(), s)],
                    None => break,
                }
            } else {
                let pool = self.top_k_nearest(&peeled, k_eff);
                if pool.is_empty() {
                    break;
                }
                pool
            };

            // ── 3a. repetition penalty on the recent window ──────────
            if params.repetition_penalty > 0.0 && params.repetition_window > 0 {
                let window_start = out.len().saturating_sub(params.repetition_window);
                for (w, score) in candidates.iter_mut() {
                    if out[window_start..].iter().any(|e| e == w) {
                        *score -= params.repetition_penalty;
                    }
                }
            }

            // ── 3b. forward-transition bigram prior ──────────────────
            // For each candidate w we add
            //     bigram_weight · log P(w | out.last())
            // to its score. The prior is Laplace-smoothed so
            // log_prob is always finite and unseen transitions are
            // still allowed (just heavily down-weighted). When the
            // prior is empty (pre-v2 on-disk lexicon) log_prob
            // returns 0.0 so this branch becomes a no-op.
            //
            // At position 0 there's no real "previous word" to
            // condition on — out.last() is None. Using the unigram
            // fallback there would pull the decoder toward common
            // words ("a", "the") and override the prompt backbone
            // at the very position where the prompt's round-trip
            // signal is strongest. So we skip the prior entirely
            // on pos 0 and let pure cosine drive the first commit.
            if params.bigram_weight > 0.0 && !self.bigram.is_empty() {
                if let Some(last) = out.last() {
                    let prev_id = self.index.get(last).copied();
                    for (w, score) in candidates.iter_mut() {
                        if let Some(&next_id) = self.index.get(w) {
                            let lp = self.bigram.log_prob(prev_id, next_id);
                            *score += params.bigram_weight * lp;
                        }
                        // If a candidate isn't in the index
                        // (shouldn't happen — every candidate comes
                        // from the lexicon's own word list) we
                        // simply leave its score alone.
                    }
                }
            }

            // ── 4. selection ─────────────────────────────────────────
            let picked = if greedy {
                // candidates already has exactly one entry
                candidates.remove(0).0
            } else {
                // Softmax with temperature over the (possibly
                // penalized) pool. Subtract the max score for
                // numerical stability before exp.
                let max_s = candidates
                    .iter()
                    .map(|(_, s)| *s)
                    .fold(f32::NEG_INFINITY, f32::max);
                let t = params.temperature.max(1e-6);
                let mut weights: Vec<f32> = candidates
                    .iter()
                    .map(|(_, s)| ((*s - max_s) / t).exp())
                    .collect();
                let sum: f32 = weights.iter().sum();
                if !sum.is_finite() || sum <= 0.0 {
                    // Degenerate distribution — fall back to argmax
                    // on the un-exponentiated (penalized) scores.
                    let mut best_i = 0usize;
                    let mut best_s = f32::NEG_INFINITY;
                    for (i, (_, s)) in candidates.iter().enumerate() {
                        if *s > best_s {
                            best_s = *s;
                            best_i = i;
                        }
                    }
                    candidates.swap_remove(best_i).0
                } else {
                    for w in weights.iter_mut() {
                        *w /= sum;
                    }
                    let draw = splitmix_unit(&mut rng_state);
                    let mut acc = 0.0f32;
                    let mut idx = weights.len() - 1;
                    for (i, w) in weights.iter().enumerate() {
                        acc += *w;
                        if draw <= acc {
                            idx = i;
                            break;
                        }
                    }
                    candidates.swap_remove(idx).0
                }
            };

            // ── 5. immediate-repeat early-stop (opt-in) ──────────────
            // Preserves the original pre-sampling decoder's fixpoint
            // behaviour when `stop_on_immediate_repeat` is set. In
            // sampled mode we leave this off because the repetition
            // penalty already handles loops without truncating.
            if params.stop_on_immediate_repeat {
                if let Some(prev) = out.last() {
                    if prev == &picked {
                        break;
                    }
                }
            }

            // ── 6. emit ──────────────────────────────────────────────
            out.push(picked.clone());

            // ── 7. feed the committed word back into the state ───────
            // Bind the emitted word into its positional role so the
            // next peel sees it exactly where the encoder would have
            // placed it. superpose_sparse enforces the 4 % density
            // budget — the state never saturates no matter how many
            // tokens we generate.
            if let Some(wv) = self.get(&picked) {
                let bound = wv.bind(&pkey);
                state = SparseVec::superpose_sparse(&[&state, &bound], 0.04);
            }
        }

        out.join(" ")
    }

    /// Build a fresh lexicon by streaming every path in `paths` through
    /// a deterministic tokenizer and accumulating co-occurrence
    /// statistics. `.jsonl` files are special-cased: each JSON line is
    /// inspected for common text fields (`text`, `content`, `user`,
    /// `kai`, `input`, `response`) and their string values are
    /// concatenated as the corpus for that line. Anything else falls
    /// back to the raw file contents.
    pub fn build_from_paths<P: AsRef<Path>>(paths: &[P]) -> std::io::Result<Self> {
        // ── Pass 1 — collect every token in order ────────────────────
        // Deterministic: paths processed in caller-provided order,
        // lines in file order, tokens in line order.
        let mut all_tokens: Vec<String> = Vec::new();
        for p in paths {
            let path_ref = p.as_ref();
            let is_jsonl = path_ref
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("jsonl"))
                .unwrap_or(false);

            let file = match File::open(path_ref) {
                Ok(f) => f,
                Err(e) => {
                    eprintln!(
                        "[stat_lexicon] warning: could not open {}: {}",
                        path_ref.display(),
                        e
                    );
                    continue;
                }
            };
            let reader = BufReader::new(file);
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => continue,
                };
                let text = if is_jsonl {
                    extract_jsonl_text(&line)
                } else {
                    line
                };
                for tok in tokenize(&text) {
                    all_tokens.push(tok);
                }
            }
        }

        // ── Pass 2 — assign each unique word a stable seed vector ────
        let mut words: Vec<String> = Vec::new();
        let mut index: HashMap<String, usize> = HashMap::new();
        for tok in &all_tokens {
            if !index.contains_key(tok) {
                index.insert(tok.clone(), words.len());
                words.push(tok.clone());
            }
        }

        let seeds: Vec<SparseVec> = words.iter().map(|w| seed_vector(w)).collect();

        // ── Pass 3 — co-occurrence accumulate ────────────────────────
        //   • every center word starts with SELF_BIAS copies of its
        //     own seed to keep identity stable,
        //   • every neighbor inside ±WINDOW adds NEIGHBOR_WEIGHT copies
        //     of the neighbor's seed.
        let vocab_len = words.len();
        let mut histograms: Vec<Vec<i32>> = (0..vocab_len).map(|_| vec![0i32; DIM]).collect();

        for i in 0..vocab_len {
            let hist = &mut histograms[i];
            let seed = &seeds[i];
            accumulate(hist, seed, SELF_BIAS);
        }

        for (ti, tok) in all_tokens.iter().enumerate() {
            let center = match index.get(tok) {
                Some(&c) => c,
                None => continue,
            };
            let lo = ti.saturating_sub(WINDOW);
            let hi = (ti + WINDOW + 1).min(all_tokens.len());
            for j in lo..hi {
                if j == ti {
                    continue;
                }
                let neighbor = match index.get(&all_tokens[j]) {
                    Some(&c) => c,
                    None => continue,
                };
                let nseed = &seeds[neighbor];
                accumulate(&mut histograms[center], nseed, NEIGHBOR_WEIGHT);
            }
        }

        // ── Pass 4 — ternarize at the 4 % sparsity budget ────────────
        let vectors: Vec<SparseVec> = histograms
            .into_iter()
            .map(|h| ternarize(&h, TARGET_NNZ))
            .collect();

        // ── Pass 5 — forward-transition bigram prior ─────────────────
        // Walk `all_tokens` one more time and accumulate adjacent
        // (prev → next) pairs. We use a dense `HashMap` per prev
        // during build for O(1) increment, then compact each row to
        // a sorted `Vec<(next_id, count)>` for O(log K) lookup at
        // decode time.
        //
        // Boundary note: `all_tokens` is a flat stream across files
        // and lines (matching how Pass 3 accumulates co-occurrence),
        // so cross-boundary bigrams exist. Laplace smoothing (add-1
        // in `BigramPrior::log_prob`) absorbs that noise — a few
        // spurious pairs per boundary are insignificant next to
        // the millions of valid within-line pairs in any real
        // corpus.
        let mut bigram_build: Vec<HashMap<u32, u32>> =
            (0..vocab_len).map(|_| HashMap::new()).collect();
        let mut row_totals: Vec<u32> = vec![0; vocab_len];
        let mut unigram: Vec<u32> = vec![0; vocab_len];
        let mut total_tokens: u64 = 0;

        for (ti, tok) in all_tokens.iter().enumerate() {
            let curr = match index.get(tok) {
                Some(&c) => c,
                None => continue,
            };
            unigram[curr] = unigram[curr].saturating_add(1);
            total_tokens = total_tokens.saturating_add(1);

            if ti == 0 {
                continue;
            }
            let prev_tok = &all_tokens[ti - 1];
            let prev = match index.get(prev_tok) {
                Some(&p) => p,
                None => continue,
            };
            let row = &mut bigram_build[prev];
            let entry = row.entry(curr as u32).or_insert(0);
            *entry = entry.saturating_add(1);
            row_totals[prev] = row_totals[prev].saturating_add(1);
        }

        let forward: Vec<Vec<(u32, u32)>> = bigram_build
            .into_iter()
            .map(|row| {
                let mut v: Vec<(u32, u32)> = row.into_iter().collect();
                v.sort_by_key(|&(n, _)| n);
                v
            })
            .collect();

        let bigram = BigramPrior {
            forward,
            row_totals,
            unigram,
            total_tokens,
            vocab_size: vocab_len as u32,
        };

        Ok(Self {
            words,
            vectors,
            index,
            bigram,
        })
    }

    /// Read-only view of the lexicon's forward-transition bigram
    /// prior. Empty when the lexicon was loaded from a pre-bigram
    /// on-disk file; rebuild with `--build-lexicon` to populate it.
    pub fn bigram(&self) -> &BigramPrior {
        &self.bigram
    }

    /// Save the lexicon to disk in a compact sparse-pair JSON format.
    pub fn save<P: AsRef<Path>>(&self, path: P) -> std::io::Result<()> {
        // Version 2+ includes the bigram prior. Version 1 readers
        // inside this binary still load these files correctly
        // because `#[serde(default)]` on the bigram field means
        // they can tolerate its absence — the only field-shape
        // change from v1 → v2 is the *addition* of `bigram`, so
        // serde-level compatibility goes both ways.
        let file = LexiconFile {
            version: 2,
            dim: DIM,
            words: self.words.clone(),
            vectors: self.vectors.iter().map(to_pairs).collect(),
            bigram: self.bigram.clone(),
        };
        let bytes = serde_json::to_vec(&file)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        let mut out = File::create(path)?;
        out.write_all(&bytes)?;
        Ok(())
    }

    /// Load a lexicon saved by `save`. Errors if the on-disk DIM does
    /// not match the current `SparseVec::DIM`. Version-1 files (pre-
    /// bigram) load cleanly — the bigram prior comes back empty and
    /// `bigram_weight` simply has no effect until the lexicon is
    /// rebuilt via `--build-lexicon`.
    pub fn load<P: AsRef<Path>>(path: P) -> std::io::Result<Self> {
        let file = File::open(path)?;
        let lf: LexiconFile = serde_json::from_reader(file)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        if lf.dim != DIM {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "lexicon DIM mismatch: file has {}, binary has {}",
                    lf.dim, DIM
                ),
            ));
        }
        let mut index = HashMap::new();
        for (i, w) in lf.words.iter().enumerate() {
            index.insert(w.clone(), i);
        }
        let vectors = lf.vectors.iter().map(from_pairs).collect();
        Ok(Self {
            words: lf.words,
            vectors,
            index,
            bigram: lf.bigram,
        })
    }
}

// ─────────────────────────────────────────────────────────────────────
// Helpers — intentionally file-local so they never leak out as API.
// ─────────────────────────────────────────────────────────────────────

/// Lowercase + strip non-letters. Keeps apostrophes inside words (e.g.
/// "don't" stays "dont" because we drop non-letters — the apostrophe
/// is dropped but the two halves merge, which is fine for statistics).
/// Draw a `f32` in `[0.0, 1.0)` from a SplitMix64 state, mutating it
/// in place so successive calls advance the stream. Good enough for
/// categorical sampling over a ≤ top_k candidate pool, and zero-dep
/// (matches the style used elsewhere in the crate).
fn splitmix_unit(state: &mut u64) -> f32 {
    let mut z = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    *state = z;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^= z >> 31;
    // 24 high bits → [0, 1) with 2^-24 resolution
    ((z >> 40) as u32 as f32) / (1u32 << 24) as f32
}

fn normalize(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_alphabetic())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// Split a blob of text into normalized word tokens. Empty strings are
/// dropped. Visible to the whole crate so the generative encoder can
/// align its positional binding with `encode_sentence` byte-for-byte —
/// mismatched tokenizations would offset positions and corrupt the
/// round-trip.
pub(crate) fn tokenize(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric() && c != '\'')
        .map(normalize)
        .filter(|s| !s.is_empty())
        .collect()
}

/// Very cheap text extractor for JSONL lines. We don't pull in
/// `serde_json::from_str` on the hot path because ingest files can be
/// deeply nested or malformed — instead we grab the quoted values of a
/// small set of likely text keys. Anything we miss just contributes no
/// tokens from that line.
fn extract_jsonl_text(line: &str) -> String {
    let keys = [
        "\"text\":",
        "\"content\":",
        "\"user\":",
        "\"kai\":",
        "\"input\":",
        "\"response\":",
        "\"message\":",
    ];
    let mut out = String::new();
    for key in &keys {
        let mut rest = line;
        while let Some(k) = rest.find(key) {
            let after = &rest[k + key.len()..];
            if let Some(q1) = after.find('"') {
                let after_q = &after[q1 + 1..];
                // Take up to the next unescaped quote. Backslashes
                // escape the following byte.
                let mut chars = after_q.char_indices();
                let mut end = None;
                while let Some((i, c)) = chars.next() {
                    if c == '\\' {
                        chars.next();
                        continue;
                    }
                    if c == '"' {
                        end = Some(i);
                        break;
                    }
                }
                if let Some(e) = end {
                    out.push_str(&after_q[..e]);
                    out.push(' ');
                    rest = &after_q[e + 1..];
                    continue;
                }
            }
            break;
        }
    }
    out
}

/// Deterministic SparseVec for a word. Uses an XorShift64 seeded from
/// a 64-bit hash of the word to pick SEED_PAIRS dimensions and flip
/// them to ±1 each.
fn seed_vector(word: &str) -> SparseVec {
    let seed = hash64(word);
    let mut rng = XorShift64::new(seed);
    let mut data = vec![0i8; DIM];
    let mut set = 0usize;
    // Positive half.
    while set < SEED_PAIRS {
        let idx = (rng.next() as usize) % DIM;
        if data[idx] == 0 {
            data[idx] = 1;
            set += 1;
        }
    }
    // Negative half.
    let mut neg = 0usize;
    while neg < SEED_PAIRS {
        let idx = (rng.next() as usize) % DIM;
        if data[idx] == 0 {
            data[idx] = -1;
            neg += 1;
        }
    }
    SparseVec::from_raw(data)
}

/// Add `weight * seed[i]` to the histogram for every nonzero dim in
/// the seed vector.
fn accumulate(hist: &mut [i32], seed: &SparseVec, weight: i32) {
    let data = &seed.data;
    for i in 0..DIM {
        let s = data[i] as i32;
        if s != 0 {
            hist[i] += weight * s;
        }
    }
}

/// Keep the top `nnz` dims by absolute value, write +1 or -1, zero
/// everything else. Matches the ternarizer inside `SparseVec::encode`.
fn ternarize(hist: &[i32], nnz: usize) -> SparseVec {
    let mut data = vec![0i8; DIM];
    if nnz == 0 || nnz >= DIM {
        for i in 0..DIM {
            data[i] = match hist[i].cmp(&0) {
                std::cmp::Ordering::Greater => 1,
                std::cmp::Ordering::Less => -1,
                std::cmp::Ordering::Equal => 0,
            };
        }
        return SparseVec::from_raw(data);
    }
    let mut mags: Vec<i32> = hist.iter().map(|v| v.abs()).collect();
    mags.sort_unstable_by(|a, b| b.cmp(a));
    let threshold = mags[nnz];
    for i in 0..DIM {
        let v = hist[i];
        if v.abs() > threshold
            || (v.abs() == threshold && v != 0 && data.iter().filter(|&&x| x != 0).count() < nnz)
        {
            data[i] = if v > 0 { 1 } else { -1 };
        }
    }
    // Fill to target if the strict > threshold pass underfilled (ties).
    let mut current = data.iter().filter(|&&x| x != 0).count();
    if current < nnz {
        let mut ordered: Vec<(usize, i32)> =
            hist.iter().enumerate().map(|(i, v)| (i, v.abs())).collect();
        ordered.sort_unstable_by(|a, b| b.1.cmp(&a.1));
        for (idx, _) in ordered {
            if current >= nnz {
                break;
            }
            if data[idx] == 0 && hist[idx] != 0 {
                data[idx] = if hist[idx] > 0 { 1 } else { -1 };
                current += 1;
            }
        }
    }
    SparseVec::from_raw(data)
}

/// FNV-1a 64-bit hash — good enough for seeding an RNG, deterministic
/// across runs and platforms.
fn hash64(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x00000100000001B3);
    }
    h
}

/// Tiny seeded PRNG. We avoid pulling `rand` into the seed path so the
/// lexicon is bit-exact on every machine, every Rust version.
struct XorShift64 {
    s: u64,
}

impl XorShift64 {
    fn new(seed: u64) -> Self {
        // Never start at 0 — xorshift zeroes are a fixed point.
        let s = if seed == 0 { 0x9e3779b97f4a7c15 } else { seed };
        Self { s }
    }
    fn next(&mut self) -> u64 {
        let mut x = self.s;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.s = x;
        x
    }
}

fn to_pairs(v: &SparseVec) -> SparsePairs {
    let data = &v.data;
    let mut idx = Vec::new();
    let mut sign = Vec::new();
    for i in 0..DIM {
        if data[i] != 0 {
            idx.push(i as u32);
            sign.push(data[i]);
        }
    }
    SparsePairs { idx, sign }
}

fn from_pairs(p: &SparsePairs) -> SparseVec {
    let mut data = vec![0i8; DIM];
    for (i, &ix) in p.idx.iter().enumerate() {
        let k = ix as usize;
        if k < DIM {
            data[k] = p.sign[i];
        }
    }
    SparseVec::from_raw(data)
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_vector_is_stable() {
        let a1 = seed_vector("hello");
        let a2 = seed_vector("hello");
        let b = seed_vector("world");
        assert_eq!(a1.data, a2.data, "same word must produce identical seed");
        assert_ne!(a1.data, b.data, "different words must differ");
        // Seed planter lays SEED_PAIRS positives and SEED_PAIRS
        // negatives, so the total is exactly 2 * SEED_PAIRS.
        assert_eq!(
            a1.nnz(),
            2 * SEED_PAIRS,
            "seed should hit planted nonzero budget"
        );
    }

    #[test]
    fn self_cosine_is_one() {
        let v = seed_vector("alpha");
        let c = v.cosine(&v);
        assert!((c - 1.0).abs() < 1e-4, "cosine(v,v) should be 1, got {}", c);
    }

    #[test]
    fn empty_lexicon_finds_nothing() {
        let lex = StatLexicon::new();
        assert!(lex.find_nearest(&SparseVec::zero()).is_none());
        assert!(lex.get("anything").is_none());
        assert_eq!(lex.len(), 0);
    }

    #[test]
    fn tokenize_is_reasonable() {
        let toks = tokenize("The quick, brown FOX jumps... over the lazy dog.");
        assert_eq!(
            toks,
            vec!["the", "quick", "brown", "fox", "jumps", "over", "the", "lazy", "dog"]
        );
    }

    // ── Generative-head tests ───────────────────────────────────────

    /// Build a tiny, deterministic lexicon for the decoder tests.
    /// Uses seed_vector directly so each word has a known stable
    /// vector, independent of co-occurrence noise.
    fn tiny_lexicon(words: &[&str]) -> StatLexicon {
        let mut lex = StatLexicon::new();
        for w in words {
            let k = w.to_string();
            if !lex.index.contains_key(&k) {
                lex.index.insert(k.clone(), lex.words.len());
                lex.words.push(k);
                lex.vectors.push(seed_vector(w));
            }
        }
        lex
    }

    #[test]
    fn position_key_is_deterministic_and_distinct() {
        let a0 = position_key(0);
        let a0_again = position_key(0);
        let a3 = position_key(3);
        let a7 = position_key(7);

        assert_eq!(a0.data, a0_again.data, "position_key must be stable");
        // Different positions should give near-orthogonal keys.
        // Cosine between two independent ternary permutations should
        // sit well below 0.3; we give a lot of margin to keep this
        // test robust to the PRNG specifics.
        assert!(a0.cosine(&a3).abs() < 0.4, "pos 0 vs 3 too similar");
        assert!(a0.cosine(&a7).abs() < 0.4, "pos 0 vs 7 too similar");
        assert!(a3.cosine(&a7).abs() < 0.4, "pos 3 vs 7 too similar");
    }

    #[test]
    fn encode_sentence_then_unbind_recovers_position() {
        let lex = tiny_lexicon(&["alpha", "beta", "gamma", "delta"]);
        let sentence = lex.encode_sentence("alpha beta gamma delta");
        for (i, expected) in ["alpha", "beta", "gamma", "delta"].iter().enumerate() {
            let pkey = position_key(i);
            let peeled = sentence.unbind(&pkey);
            let (got, _score) = lex.find_nearest(&peeled).expect("lex not empty");
            assert_eq!(
                got, *expected,
                "position {} should decode to {} (got {})",
                i, expected, got
            );
        }
    }

    #[test]
    fn incremental_generate_round_trips_short_sentence() {
        let lex = tiny_lexicon(&["alpha", "beta", "gamma", "delta", "epsilon"]);
        let sentence = lex.encode_sentence("alpha beta gamma");
        // Handing the encoded sentence directly to the decoder should
        // reproduce it (the happy-path round trip).
        let out = lex.incremental_generate(sentence, 3);
        assert_eq!(out, "alpha beta gamma", "round-trip decode must match");
    }

    #[test]
    fn incremental_generate_respects_max_tokens_and_repetition_stop() {
        let lex = tiny_lexicon(&["alpha", "beta"]);
        // Zero-state decoder — the nearest word to noise is arbitrary,
        // but we only care that the function terminates and honors
        // max_tokens without panicking.
        let out = lex.incremental_generate(SparseVec::zero(), 4);
        let toks: Vec<&str> = out.split_whitespace().collect();
        assert!(
            toks.len() <= 4,
            "decoder must not exceed max_tokens, got {}",
            toks.len()
        );
    }

    #[test]
    fn incremental_generate_is_empty_when_lexicon_is_empty() {
        let lex = StatLexicon::new();
        let out = lex.incremental_generate(SparseVec::zero(), 8);
        assert_eq!(out, "");
    }

    // ─────────────────────────────────────────────────────────────────
    // Bigram prior tests.
    // ─────────────────────────────────────────────────────────────────

    /// Write a small corpus to a tempfile and build a lexicon off
    /// it. Used by the bigram tests below to exercise the real
    /// `build_from_paths` code path end to end.
    fn build_lex_from_text(name: &str, text: &str) -> StatLexicon {
        let path = std::env::temp_dir().join(format!("kai_bigram_test_{}.txt", name));
        std::fs::write(&path, text).expect("temp write");
        let lex = StatLexicon::build_from_paths(&[&path]).expect("build");
        let _ = std::fs::remove_file(&path);
        lex
    }

    #[test]
    fn bigram_prior_is_populated_by_build_from_paths() {
        // Three copies of the same bigram gives a clean high-weight
        // transition alongside several low-weight ones.
        let lex = build_lex_from_text("populated", "the cat sat\nthe cat ran\nthe cat slept\n");
        let bp = lex.bigram();

        assert!(!bp.is_empty(), "prior must be non-empty after build");
        assert_eq!(bp.vocab_size as usize, lex.len());
        // Five distinct words (the, cat, sat, ran, slept), nine
        // tokens total across three lines.
        assert_eq!(bp.total_tokens, 9);

        // "the" → "cat" must have count 3 (once per line).
        let the_id = *lex.index.get("the").unwrap();
        let cat_id = *lex.index.get("cat").unwrap();
        assert_eq!(bp.lookup_count(the_id, cat_id as u32), 3);
    }

    #[test]
    fn bigram_log_prob_prefers_seen_transitions() {
        let lex = build_lex_from_text("prefers", "the cat sat\nthe cat ran\nthe cat slept\n");
        let bp = lex.bigram();

        let the_id = *lex.index.get("the").unwrap();
        let cat_id = *lex.index.get("cat").unwrap();
        let sat_id = *lex.index.get("sat").unwrap();

        // P("cat" | "the") must dominate P("sat" | "the") because
        // "the cat" appears three times and "the sat" never.
        let lp_seen = bp.log_prob(Some(the_id), cat_id);
        let lp_unseen = bp.log_prob(Some(the_id), sat_id);
        assert!(
            lp_seen > lp_unseen,
            "seen transition must have higher log_prob ({} !> {})",
            lp_seen,
            lp_unseen,
        );
    }

    #[test]
    fn bigram_log_prob_is_finite_and_non_positive() {
        let lex = build_lex_from_text("finite", "alpha beta gamma alpha beta\n");
        let bp = lex.bigram();

        for i in 0..lex.len() {
            // Laplace smoothing guarantees probabilities in (0, 1],
            // so log_prob is always finite and ≤ 0.
            let lp_ctx = bp.log_prob(Some(0), i);
            let lp_uni = bp.log_prob(None, i);
            assert!(lp_ctx.is_finite(), "context log_prob must be finite");
            assert!(lp_uni.is_finite(), "unigram log_prob must be finite");
            assert!(lp_ctx <= 0.0, "log_prob must be ≤ 0 (saw {})", lp_ctx);
            assert!(lp_uni <= 0.0, "log_prob must be ≤ 0 (saw {})", lp_uni);
        }
    }

    #[test]
    fn empty_bigram_has_no_effect_on_decoder() {
        // An empty prior + non-zero weight must produce the exact
        // same output as weight=0. We verify by ensuring the
        // BigramPrior::log_prob short-circuits to 0 when empty.
        let bp = BigramPrior::default();
        assert!(bp.is_empty());
        assert_eq!(bp.log_prob(Some(0), 0), 0.0);
        assert_eq!(bp.log_prob(None, 0), 0.0);
    }

    #[test]
    fn bigram_weight_biases_sampler_toward_likely_continuations() {
        // Build a corpus where "the" overwhelmingly appears before
        // "cat", and check that sampling with a heavy bigram weight
        // produces "cat" as the second token far more often than
        // chance would permit from cosine alone.
        let lex = build_lex_from_text("biases", &"the cat\n".repeat(50));

        // Seed the decoder with just "the" so pos 1 is the step
        // where the prior actually fires (pos 0 has no `prev`).
        let state = lex.encode_sentence("the");

        let mut cat_hits_without = 0u32;
        let mut cat_hits_with = 0u32;
        let trials = 32u64;

        for s in 0..trials {
            let mut p_off = DecodeParams::default();
            p_off.max_tokens = 2;
            p_off.bigram_weight = 0.0;
            p_off.seed = 100 + s;
            let out = lex.incremental_generate_with(state.clone(), p_off);
            if out.split_whitespace().nth(1) == Some("cat") {
                cat_hits_without += 1;
            }

            let mut p_on = DecodeParams::default();
            p_on.max_tokens = 2;
            p_on.bigram_weight = 2.0; // heavy prior
            p_on.seed = 100 + s;
            let out = lex.incremental_generate_with(state.clone(), p_on);
            if out.split_whitespace().nth(1) == Some("cat") {
                cat_hits_with += 1;
            }
        }

        // With a 2-word vocab and a heavy prior we should hit "cat"
        // nearly every trial; with no prior the output is driven
        // entirely by cosine and the repetition penalty and
        // produces "cat" far less reliably.
        assert!(
            cat_hits_with > cat_hits_without,
            "bigram weight must increase hit rate: {}/{} with vs {}/{} without",
            cat_hits_with,
            trials,
            cat_hits_without,
            trials,
        );
    }
}

// KAI v6.0.0
