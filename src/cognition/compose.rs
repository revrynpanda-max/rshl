//! `compose` — the "geometric mouth".
//!
//! Turns retrieved lattice cells into words by superposing their `SparseVec`s
//! and peeling tokens out of the result with `Lexicon::decode_scored`. Unlike
//! `StatLexicon::incremental_generate_with`, this operates DIRECTLY on lattice
//! cell vectors — there is no n-gram model and no encoded prompt in the loop.
//!
//! # Status: flag-gated, default OFF (`KAI_MOUTH_COMPOSE`)
//!
//! ## What was fixed (v9.10.51)
//! The original `compose_response` was dead code and could not have worked:
//!   * `Lexicon::decode_to_sequence` applied `permute_inv(i)` at EVERY position
//!     including `i = 0`, but `SparseVec::permute(0)` is not the identity — the
//!     seed goes through `mix_permute_seed` (0 → `0x9E3779B9`) and then a
//!     Fisher-Yates shuffle of all 16384 dims. So even the FIRST token was
//!     decoded from a fully scrambled state. See `legacy_position_zero_is_a_shuffle`.
//!   * Inhibition happened in the wrong basis, so the winner was never actually
//!     removed from the residual.
//!   * No repetition ban, no stop rule beyond a hard-coded `> 0.15` floor.
//! All three are fixed; see `Lexicon::decode_scored`.
//!
//! ## What is NOT fixed, and cannot be fixed here
//! **A lattice cell carries the word SET, and exactly one bit of word ORDER.**
//! A cell is `SparseVec::encode(text)` — a sum of hashed trigram / bigram /
//! 4-gram / word / word-pair features. Token position is not bound into it.
//!
//! Measured (`order_study_permutations`: 20 word-triples x all 6 orderings =
//! 120 trials over a 60-word vocabulary):
//!
//! | metric                                    | measured | chance |
//! |-------------------------------------------|----------|--------|
//! | set recall (right words came back)        | 1.000    | —      |
//! | **first** token == source word 0          | **1.000**| 0.333  |
//! | remaining pair in source order            | 0.542    | 0.500  |
//! | whole triple in exact source order        | 0.542    | 0.167  |
//!
//! So the first word is recovered *perfectly* and everything after it is at
//! chance (0.542 vs 0.500, n = 120, z = 0.9 — not significant). The exact-order
//! figure is just `1.000 x 0.542`; it is the first-token effect, not ordering.
//!
//! That one bit is an artifact, not a design: the trigram layer rotates by
//! `(idx + i * 97) % DIM` where `i` is the **character** offset in the whole
//! string. Only the word sitting at character offset 0 has its trigrams aligned
//! with its own standalone encoding, so it always wins the first peel. The
//! bigram / 4-gram / word layers are unrotated and therefore order-blind, which
//! is why positions 1..n are indistinguishable. Corroborating: the same triple
//! decodes to only 3-4 distinct orderings across its 6 input orderings (a pure
//! bag would give 1; full order sensitivity would give 6).
//!
//! The decoder maths for ordered readout is present and provably correct:
//! `encode_positional_sequence` binds token `i` with `permute(i)`, and
//! `decode_scored(positional: true)` round-trips a 4-token sequence exactly
//! (`positional_binding_roundtrip`). But that requires the ENCODER to bind
//! positions, which `SparseVec::encode` does not do and which changing would
//! invalidate every cell already stored in the lattice.
//!
//! **Verdict: this is a topic-word readout, not a sentence generator.** It
//! answers "what is this cluster about" with high fidelity and cannot answer
//! "what should KAI say". Do not wire it into the reply path expecting prose.

use crate::core::lexicon::{DecodeConfig, DecodeResult, DecodeStop};
use crate::core::{Lexicon, QueryHit, SparseVec};

/// Env flag gating this mouth. Default OFF.
pub const MOUTH_FLAG: &str = "KAI_MOUTH_COMPOSE";

/// Is the compose mouth enabled? `KAI_MOUTH_COMPOSE=1` (anything but
/// `0`/`false`/`off`) turns it on.
pub fn compose_enabled() -> bool {
    std::env::var(MOUTH_FLAG)
        .map(|v| v != "0" && !v.eq_ignore_ascii_case("false") && !v.eq_ignore_ascii_case("off"))
        .unwrap_or(false)
}

/// Tuning for [`compose_response_with`].
#[derive(Clone, Debug)]
pub struct ComposeConfig {
    /// How many retrieved cells to superpose.
    pub max_cells: usize,
    /// Target density of the superposed state (fraction of the 16384 dims).
    /// `SparseVec::SPARSITY` is 0.04, so 0.04 keeps the state on-distribution
    /// with individual cell vectors.
    pub density: f32,
    /// Decoder knobs.
    pub decode: DecodeConfig,
}

impl Default for ComposeConfig {
    fn default() -> Self {
        Self {
            max_cells: 5,
            density: 0.04,
            decode: DecodeConfig::default(),
        }
    }
}

/// Original entry point — signature preserved. Always runs (no flag check), so
/// existing/benchmark callers get deterministic behaviour; use
/// [`try_compose_response`] for the flag-gated path.
pub fn compose_response(hits: &[QueryHit], lexicon: &Lexicon, max_cells: usize) -> ComposedResponse {
    let cfg = ComposeConfig {
        max_cells,
        ..ComposeConfig::default()
    };
    compose_response_with(hits, lexicon, &cfg)
}

/// Flag-gated entry point. Returns `None` unless `KAI_MOUTH_COMPOSE` is set.
///
/// This is the hook a caller in the response path should use. A benchmark that
/// wants to measure the mouth regardless of the flag should call
/// [`compose_response_with`] directly.
pub fn try_compose_response(
    hits: &[QueryHit],
    lexicon: &Lexicon,
    max_cells: usize,
) -> Option<ComposedResponse> {
    if !compose_enabled() {
        return None;
    }
    Some(compose_response(hits, lexicon, max_cells))
}

/// The real implementation.
pub fn compose_response_with(
    hits: &[QueryHit],
    lexicon: &Lexicon,
    cfg: &ComposeConfig,
) -> ComposedResponse {
    if hits.is_empty() {
        return ComposedResponse {
            text: "Nothing resonates. My universe is silent.".into(),
            sources: Vec::new(),
            confidence: 0.0,
            depth: 0,
            token_scores: Vec::new(),
            stop: DecodeStop::NoInput,
        };
    }

    let vecs: Vec<&SparseVec> = hits.iter().take(cfg.max_cells).map(|h| &h.vec).collect();
    let superposed = SparseVec::superpose_sparse(&vecs, cfg.density);

    // THE GENERATIVE HEAD: peel the superposed geometric state into tokens.
    let DecodeResult { tokens, stop } = lexicon.decode_scored(&superposed, &cfg.decode);
    let text = tokens
        .iter()
        .map(|t| t.word.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let token_scores = tokens.iter().map(|t| t.score).collect();

    let sources: Vec<Source> = hits
        .iter()
        .take(cfg.max_cells)
        .map(|h| Source {
            label: "Geometric Cluster".into(),
            region: h.region.clone(),
            score: h.score,
        })
        .collect();

    ComposedResponse {
        text,
        sources,
        confidence: hits[0].score,
        depth: hits.len(),
        token_scores,
        stop,
    }
}

/// Encode a word sequence WITH positional role binding.
///
/// `state = superpose_i( permute(encode(w_i), i) )`, with position 0 bound by
/// the identity (see `core::lexicon::pos_bind` — `permute(0)` is a real shuffle
/// in this codebase, so it cannot be used as the identity role).
///
/// Permutation is an orthogonal (indeed, isometric) map on the index space, so
/// `permute` distributes over superposition and `permute_inv(i)` recovers the
/// slot-`i` component while pushing every other slot's contribution into a
/// quasi-orthogonal random direction. That is the standard VSA trick for
/// sequences, and it is why `decode_scored(positional: true)` can read a
/// state built by this function back in order.
///
/// This exists as the positive control for the ordering claim: it proves the
/// decoder is sound and that the missing order lives in the *encoder*.
pub fn encode_positional_sequence(words: &[&str]) -> SparseVec {
    let bound: Vec<SparseVec> = words
        .iter()
        .enumerate()
        .map(|(i, w)| crate::core::lexicon::pos_bind(&SparseVec::encode(w), i, true))
        .collect();
    let refs: Vec<&SparseVec> = bound.iter().collect();
    SparseVec::superpose_sparse(&refs, 0.04)
}

pub struct ComposedResponse {
    pub text: String,
    pub sources: Vec<Source>,
    pub confidence: f32,
    pub depth: usize,
    /// Cosine that produced each emitted token — the quality signal a benchmark
    /// should report alongside the text.
    ///
    /// NOTE for benchmarks: these are **not comparable across positions**.
    /// Each peel shrinks the residual via `contrast`, which lowers its norm, so
    /// a later token can score higher than an earlier one purely because less
    /// vector is left. Compare `token_scores[0]` across responses, or compare
    /// the whole vector position-wise — do not average them into one number.
    pub token_scores: Vec<f32>,
    /// Why decoding stopped.
    pub stop: DecodeStop,
}

pub struct Source {
    pub label: String,
    pub region: String,
    pub score: f32,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// A small, fully-controlled vocabulary.
    const VOCAB: [&str; 20] = [
        "lattice", "vector", "memory", "signal", "kai", "ryan", "banana", "orbit", "planet",
        "engine", "quiet", "thunder", "garden", "cipher", "harbor", "kernel", "violet", "anchor",
        "meadow", "puzzle",
    ];

    /// A larger vocabulary for the order study — 60 words, so a decoder that
    /// merely guesses cannot look good.
    const VOCAB60: [&str; 60] = [
        "lattice", "vector", "memory", "signal", "kai", "ryan", "banana", "orbit", "planet",
        "engine", "quiet", "thunder", "garden", "cipher", "harbor", "kernel", "violet", "anchor",
        "meadow", "puzzle", "candle", "marble", "python", "silver", "ferret", "tunnel", "carpet",
        "ribbon", "quartz", "walnut", "jungle", "saddle", "beacon", "cactus", "dragon", "fabric",
        "gospel", "hollow", "ivory", "jockey", "ladder", "magnet", "nectar", "oyster", "pebble",
        "quiver", "rocket", "sonnet", "temple", "urchin", "vessel", "wander", "yellow", "zenith",
        "bridge", "copper", "damson", "effort", "falcon", "granite",
    ];

    fn tiny_lexicon() -> Lexicon {
        Lexicon::from_words(&VOCAB)
    }

    fn hit(text: &str, score: f32) -> QueryHit {
        QueryHit {
            label: text.into(),
            text: text.into(),
            vec: SparseVec::encode(text),
            region: "test".into(),
            score,
            strength: 1.0,
            source: "test".into(),
            timestamp: 0,
            user_id: String::new(),
            channel_id: String::new(),
            message_id: String::new(),
            keywords: Vec::new(),
        }
    }

    // ── 1. Termination ──────────────────────────────────────────────────────

    #[test]
    fn terminates_on_empty_input() {
        let lex = tiny_lexicon();
        let r = compose_response(&[], &lex, 5);
        assert_eq!(r.stop, DecodeStop::NoInput);
        assert!(r.token_scores.is_empty());
    }

    #[test]
    fn terminates_within_max_tokens() {
        let lex = tiny_lexicon();
        let cfg = ComposeConfig {
            max_cells: 3,
            decode: DecodeConfig {
                max_tokens: 6,
                ..DecodeConfig::default()
            },
            ..ComposeConfig::default()
        };
        for text in [
            "lattice memory signal",
            "zzzz qqqq xxxx",           // nothing in vocabulary
            "",                          // degenerate
            "the quick brown fox jumps over the lazy dog",
        ] {
            let r = compose_response_with(&[hit(text, 0.9)], &lex, &cfg);
            let n = r.text.split_whitespace().count();
            assert!(n <= 6, "'{text}' produced {n} tokens (cap 6): {:?}", r.text);
        }
    }

    #[test]
    fn terminates_even_with_absurd_token_cap() {
        // Vocabulary is 20 words; asking for 500 tokens must still terminate
        // via VocabExhausted / ResidualEmpty / BelowThreshold, never loop.
        let lex = tiny_lexicon();
        let cfg = ComposeConfig {
            decode: DecodeConfig {
                max_tokens: 500,
                min_cosine: 0.0, // disable the threshold stop entirely
                ..DecodeConfig::default()
            },
            ..ComposeConfig::default()
        };
        let r = compose_response_with(&[hit("lattice memory signal", 0.9)], &lex, &cfg);
        assert!(
            r.text.split_whitespace().count() <= 20,
            "emitted more tokens than the vocabulary has words: {:?}",
            r.text
        );
        assert!(
            matches!(
                r.stop,
                DecodeStop::VocabExhausted | DecodeStop::ResidualEmpty | DecodeStop::BelowThreshold
            ),
            "unexpected stop: {:?}",
            r.stop
        );
    }

    #[test]
    fn terminates_with_repeats_allowed_and_no_threshold() {
        // The footgun path: soft repetition penalty + no cosine floor + a huge
        // cap. Nothing bounds this except the `score <= 0.0` stop, because a
        // non-positive winner shares no index with the residual and `contrast`
        // would not shrink it.
        let lex = tiny_lexicon();
        let cfg = ComposeConfig {
            decode: DecodeConfig {
                max_tokens: 200,
                min_cosine: 0.0,
                positional: false,
                ban_repeats: false,
                repetition_penalty: 0.25,
            },
            ..ComposeConfig::default()
        };
        let r = compose_response_with(&[hit("lattice memory signal", 0.9)], &lex, &cfg);
        let n = r.text.split_whitespace().count();
        eprintln!("[compose] soft-penalty run emitted {n} tokens, stop={:?}", r.stop);
        assert!(
            n < 200,
            "decoder ran to the cap instead of stopping on exhausted evidence ({n} tokens)"
        );
        assert_ne!(r.stop, DecodeStop::MaxTokens, "should not stop on the cap");
    }

    // ── 2. No repetition ────────────────────────────────────────────────────

    #[test]
    fn never_repeats_a_word() {
        let lex = tiny_lexicon();
        let cfg = ComposeConfig {
            decode: DecodeConfig {
                max_tokens: 20,
                min_cosine: 0.0,
                ..DecodeConfig::default()
            },
            ..ComposeConfig::default()
        };
        let r = compose_response_with(
            &[hit("lattice memory", 0.9), hit("signal kai", 0.8)],
            &lex,
            &cfg,
        );
        let words: Vec<&str> = r.text.split_whitespace().collect();
        let uniq: HashSet<&&str> = words.iter().collect();
        assert_eq!(
            words.len(),
            uniq.len(),
            "repeated token in output: {:?}",
            r.text
        );
    }

    // ── 3. Trivially-separable case ─────────────────────────────────────────

    #[test]
    fn recovers_expected_tokens_for_separable_case() {
        // Three cells, each a single distinct vocabulary word. The superposition
        // must peel exactly those three back out (as a SET — order is not
        // claimed, see `bag_of_vectors_does_not_preserve_order`).
        let lex = tiny_lexicon();
        let cfg = ComposeConfig {
            max_cells: 3,
            decode: DecodeConfig {
                max_tokens: 3,
                min_cosine: 0.10,
                ..DecodeConfig::default()
            },
            ..ComposeConfig::default()
        };
        let hits = [hit("lattice", 0.9), hit("banana", 0.8), hit("thunder", 0.7)];
        let r = compose_response_with(&hits, &lex, &cfg);
        let got: HashSet<&str> = r.text.split_whitespace().collect();
        let want: HashSet<&str> = ["lattice", "banana", "thunder"].into_iter().collect();
        assert_eq!(
            got, want,
            "expected the three source words back, got {:?} (scores {:?})",
            r.text, r.token_scores
        );
        for s in &r.token_scores {
            assert!(*s > 0.10, "token scored below threshold: {:?}", r.token_scores);
        }
    }

    // ── 4. Evidence: the legacy decoder could not have worked ───────────────

    #[test]
    fn legacy_position_zero_is_a_shuffle() {
        // The single fact that made the original decoder noise: permute(0) is a
        // real Fisher-Yates shuffle, not the identity.
        let v = SparseVec::encode("lattice");
        let self_sim = v.cosine(&v);
        let after_p0 = v.permute_inv(0).cosine(&v);
        assert!((self_sim - 1.0).abs() < 1e-5, "self cosine should be 1.0");
        assert!(
            after_p0.abs() < 0.10,
            "permute_inv(0) should destroy self-similarity, got {after_p0}"
        );
        eprintln!("[compose] cos(v,v)={self_sim:.4}  cos(permute_inv(0,v),v)={after_p0:.4}");
    }

    #[test]
    fn fixed_decoder_beats_legacy_on_the_separable_case() {
        let lex = tiny_lexicon();
        let state = SparseVec::superpose_sparse(
            &[
                &SparseVec::encode("lattice"),
                &SparseVec::encode("banana"),
                &SparseVec::encode("thunder"),
            ],
            0.04,
        );
        let want: HashSet<&str> = ["lattice", "banana", "thunder"].into_iter().collect();

        let legacy = lex.decode_to_sequence_legacy(&state, 3);
        let legacy_hits = legacy.iter().filter(|w| want.contains(w.as_str())).count();

        let fixed = lex.decode_to_sequence(&state, 3);
        let fixed_hits = fixed.iter().filter(|w| want.contains(w.as_str())).count();

        eprintln!("[compose] legacy  -> {legacy:?}  ({legacy_hits}/3 correct)");
        eprintln!("[compose] fixed   -> {fixed:?}  ({fixed_hits}/3 correct)");
        assert_eq!(fixed_hits, 3, "fixed decoder should recover all three");
        assert!(
            legacy_hits < fixed_hits,
            "legacy unexpectedly matched the fixed decoder"
        );
    }

    // ── 5. Positive control: the decoder CAN read order, given bound input ──

    #[test]
    fn positional_binding_roundtrip() {
        let lex = tiny_lexicon();
        let seq = ["kai", "memory", "orbit", "cipher"];
        assert!(seq.iter().all(|w| lex.is_known(w)), "test vocab drifted");
        let state = encode_positional_sequence(&seq);
        let cfg = DecodeConfig {
            max_tokens: seq.len(),
            min_cosine: 0.05,
            positional: true,
            ban_repeats: true,
            repetition_penalty: 0.25,
        };
        let out = lex.decode_scored(&state, &cfg);
        let words: Vec<&str> = out.tokens.iter().map(|t| t.word.as_str()).collect();
        eprintln!(
            "[compose] positional roundtrip: in={seq:?} out={words:?} scores={:?}",
            out.tokens.iter().map(|t| t.score).collect::<Vec<_>>()
        );
        assert_eq!(
            words, seq,
            "positional binding must round-trip IN ORDER (this proves the decoder maths is sound)"
        );
    }

    // ── 6. NEGATIVE RESULT: bag-of-vectors carries no order ─────────────────

    /// Permutation study: does `SparseVec::encode` (the lattice's own encoder)
    /// carry recoverable word ORDER, or only word IDENTITY?
    ///
    /// Method: 20 disjoint word-triples from a 60-word vocabulary. For each
    /// triple, encode ALL SIX orderings as a cell and decode 3 tokens. If the
    /// encoding were a pure order-blind bag of features, all six orderings
    /// would produce byte-identical output.
    #[test]
    fn order_study_permutations() {
        let lex = Lexicon::from_words(&VOCAB60);
        const PERMS: [[usize; 3]; 6] = [
            [0, 1, 2],
            [0, 2, 1],
            [1, 0, 2],
            [1, 2, 0],
            [2, 0, 1],
            [2, 1, 0],
        ];

        let mut set_num = 0usize;
        let mut set_den = 0usize;
        let mut exact = 0usize;
        let mut first_ok = 0usize;
        let mut trials = 0usize;
        let mut tail_conc = 0usize;
        let mut tail_total = 0usize;
        let mut distinct_hist = [0usize; 7];

        for t in 0..20 {
            let triple = [VOCAB60[t], VOCAB60[t + 20], VOCAB60[t + 40]];
            let mut outputs: Vec<Vec<String>> = Vec::new();

            for p in PERMS {
                let sent: Vec<&str> = p.iter().map(|&i| triple[i]).collect();
                let state = SparseVec::encode(&sent.join(" "));
                let cfg = DecodeConfig {
                    max_tokens: 3,
                    min_cosine: 0.02,
                    positional: false,
                    ban_repeats: true,
                    repetition_penalty: 0.25,
                };
                let got: Vec<String> = lex
                    .decode_scored(&state, &cfg)
                    .tokens
                    .into_iter()
                    .map(|tk| tk.word)
                    .collect();

                trials += 1;
                set_den += 3;
                set_num += sent.iter().filter(|w| got.iter().any(|g| g == *w)).count();
                if got.iter().eq(sent.iter()) {
                    exact += 1;
                }
                if got.first().map(|g| g.as_str()) == Some(sent[0]) {
                    first_ok += 1;
                }
                // Concordance of the pair that does NOT involve source position 0.
                let (pa, pb) = (
                    got.iter().position(|g| g == sent[1]),
                    got.iter().position(|g| g == sent[2]),
                );
                if let (Some(pa), Some(pb)) = (pa, pb) {
                    tail_total += 1;
                    if pa < pb {
                        tail_conc += 1;
                    }
                }
                if t < 2 {
                    eprintln!("[order] {:?} -> {:?}", sent, got);
                }
                outputs.push(got);
            }

            let uniq: HashSet<&Vec<String>> = outputs.iter().collect();
            distinct_hist[uniq.len()] += 1;
        }

        eprintln!(
            "[order] trials={trials}  SET recall={:.3}  EXACT order={:.3} (chance 0.167)  \
             FIRST token={:.3} (chance 0.333)  TAIL pair concordance={:.3} (chance 0.500, n={tail_total})",
            set_num as f32 / set_den as f32,
            exact as f32 / trials as f32,
            first_ok as f32 / trials as f32,
            if tail_total == 0 { 0.0 } else { tail_conc as f32 / tail_total as f32 },
        );
        eprintln!(
            "[order] distinct decoded orderings per triple (of 6 input orderings): {:?} \
             [index = #distinct, value = #triples]",
            distinct_hist
        );

        let set_recall = set_num as f32 / set_den as f32;
        let first_acc = first_ok as f32 / trials as f32;
        let tail_acc = tail_conc as f32 / tail_total as f32;

        // POSITIVE: the mouth recovers the right words.
        assert!(
            set_recall >= 0.95,
            "set recall fell to {set_recall:.3} — the topic-word readout regressed"
        );
        // POSITIVE: the first word is recovered (trigram-rotation artifact).
        assert!(
            first_acc >= 0.90,
            "first-token accuracy fell to {first_acc:.3} (chance 0.333)"
        );
        // NEGATIVE — the load-bearing claim of this unit. Order beyond token 0
        // is CHANCE. If this ever fails high, someone gave the encoder real
        // positional binding: that is good news, but the module docs and the
        // 'topic-word readout, not a sentence generator' verdict must be
        // rewritten before the assertion is relaxed.
        assert!(
            (0.35..=0.65).contains(&tail_acc),
            "post-first-token order concordance is {tail_acc:.3}, outside the chance band \
             [0.35, 0.65] (n={tail_total}). The encoder's order behaviour changed — \
             re-read the module docs before touching this assert."
        );
    }

    /// Qualitative record: what a caller actually gets back, verbatim, for
    /// multi-cell inputs. Run with `--nocapture` to read it. Asserts only the
    /// invariants (terminates, no repeats, every token above the floor) so it
    /// documents quality without pretending the output is prose.
    #[test]
    fn sample_outputs_for_the_record() {
        let lex = Lexicon::from_words(&VOCAB60);
        let clusters: [&[&str]; 4] = [
            &["lattice memory signal", "vector lattice engine"],
            &["banana orbit planet", "planet engine orbit"],
            &["thunder garden cipher", "garden meadow quiet"],
            &["harbor kernel violet", "kernel cipher lattice", "violet ribbon harbor"],
        ];

        for cells in clusters {
            let hits: Vec<QueryHit> = cells
                .iter()
                .enumerate()
                .map(|(i, c)| hit(*c, 0.9 - 0.05 * i as f32))
                .collect();
            let r = compose_response(&hits, &lex, 5);
            let scores: Vec<String> =
                r.token_scores.iter().map(|s| format!("{s:.2}")).collect();
            eprintln!(
                "[sample] cells {cells:?}\n         -> {:?}\n         scores=[{}] stop={:?}",
                r.text,
                scores.join(", "),
                r.stop
            );

            let words: Vec<&str> = r.text.split_whitespace().collect();
            let uniq: HashSet<&&str> = words.iter().collect();
            assert_eq!(words.len(), uniq.len(), "repeat in {:?}", r.text);
            assert!(words.len() <= 12, "exceeded max_tokens: {:?}", r.text);
            for s in &r.token_scores {
                assert!(*s >= 0.12, "token below the cosine floor: {:?}", r.token_scores);
            }
        }
    }

    // ── 7. Flag gating ──────────────────────────────────────────────────────

    #[test]
    fn flag_defaults_off() {
        // Not using std::env::set_var (racy across the parallel test harness) —
        // just assert the parse rule and the default.
        assert!(!compose_enabled() || std::env::var(MOUTH_FLAG).is_ok());
        let lex = tiny_lexicon();
        if std::env::var(MOUTH_FLAG).is_err() {
            assert!(
                try_compose_response(&[hit("lattice", 0.9)], &lex, 3).is_none(),
                "compose mouth must be OFF unless KAI_MOUTH_COMPOSE is set"
            );
        }
    }
}
