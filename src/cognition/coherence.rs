//! # The coherence critic — one calibrated judge of KAI's own speech.
//!
//! ## Why this exists
//!
//! Until now KAI had *several* partial judges and no single one that could
//! accept or reject an utterance:
//!
//!   * `voice::is_bad_output` — a long list of string rules (starts_with,
//!     contains). Catches known artifact dumps. Says nothing about whether a
//!     sentence is grammatical or on-topic.
//!   * `voice::semantic_coherence_score` — fraction of >=4-letter words the
//!     semantic dictionary knows. A perfectly scrambled sentence made of known
//!     words scores 1.0.
//!   * `GlobalWorkspace::coherence` — average pairwise cosine of what is
//!     *active in mind*. Measures the thought, not the sentence.
//!   * `phi_c` / `phi_g` — field-level resonance. Gates *whether to speak*,
//!     never *what came out*.
//!
//! The gap that mattered: `voice.rs` ran the generative decoder and then
//! returned whatever it produced **unchecked** — the only test was
//! `!decoded.trim().is_empty()`. So composition could only ever be tried as a
//! last resort, because a bad composition went straight to the user. That is
//! the structural reason KAI leans on retrieving stored phrases: retrieval is
//! the only path with a quality floor.
//!
//! This module is that floor for composed speech.
//!
//! ## What makes it "unable to lie"
//!
//! Every term is computed from data KAI already has, and none of them ask the
//! generator to assess itself:
//!
//! | Term | Question it answers | Source of truth |
//! |---|---|---|
//! | `fluency` | Is this word order one the corpus actually produces? | bigram/trigram counts in `StatLexicon` |
//! | `topicality` | Is this about what was asked? | cosine in 16384-dim RSHL space |
//! | `grounding` | Is this anchored in a retrieved memory? | cosine against the winning cell's vector |
//! | `lexical` | Are these real words with meanings? | `semantic_dict` |
//! | `structure` | Is this shaped like a sentence? | POS dictionary + token statistics |
//!
//! `fluency` is the load-bearing one and deserves its normalization spelled
//! out. `BigramPrior::log_prob` returns a Laplace-smoothed **natural log
//! probability**, so it is always negative and always finite. The natural
//! reference point is a model that picks words uniformly at random:
//!
//! ```text
//!   uniform  = ln(1 / V)  = -ln(V)
//!   fluency  = (mean_logprob - uniform) / (0 - uniform)
//!            = (mean_logprob + ln V) / ln V        clamped to [0, 1]
//! ```
//!
//! So **0.0 means "no better than shuffling the dictionary"** and 1.0 means
//! "every transition was certain." This is a real language-model score derived
//! from corpus statistics — it cannot be talked around, and it is exactly the
//! signal that separates "the lattice is processing clearly" from
//! "lattice clearly the processing is."
//!
//! ## Default is OFF
//!
//! Nothing here runs unless `KAI_COHERENCE_CRITIC=1`. With the flag unset the
//! call sites are byte-identical to their previous behavior. Tune the bar with
//! `KAI_COHERENCE_MIN` (default 0.45).

use crate::core::sparse_vec::SparseVec;
use crate::core::stat_lexicon::{tokenize, StatLexicon};

/// Default acceptance bar. Calibrated so that the fluent/grounded fixtures in
/// this module's tests clear it and the scrambled/degenerate ones do not.
pub const DEFAULT_MIN_SCORE: f32 = 0.45;

/// Is the critic enabled? `KAI_COHERENCE_CRITIC=1`.
pub fn enabled() -> bool {
    std::env::var("KAI_COHERENCE_CRITIC")
        .map(|v| v != "0" && !v.eq_ignore_ascii_case("false") && !v.eq_ignore_ascii_case("off"))
        .unwrap_or(false)
}

/// Acceptance bar, overridable with `KAI_COHERENCE_MIN`.
pub fn min_score() -> f32 {
    std::env::var("KAI_COHERENCE_MIN")
        .ok()
        .and_then(|v| v.parse::<f32>().ok())
        .filter(|v| v.is_finite() && *v >= 0.0 && *v <= 1.0)
        .unwrap_or(DEFAULT_MIN_SCORE)
}

/// How many times a composer may re-roll before giving up and letting the
/// caller fall back. Overridable with `KAI_COHERENCE_ATTEMPTS`, clamped to
/// 1..=5 — the decoder is cheap, but this sits on the conversation hot path
/// and an unbounded retry loop would turn a bad sample into a hang.
pub fn attempts() -> usize {
    std::env::var("KAI_COHERENCE_ATTEMPTS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(3)
        .clamp(1, 5)
}

/// The full, auditable judgement of one candidate utterance.
///
/// Every sub-score is kept rather than folded away, because KAI's whole
/// premise is that his internals are readable. `explain()` renders the
/// breakdown for logs and for `/api/mind/*` surfaces.
#[derive(Debug, Clone)]
pub struct CoherenceVerdict {
    /// Weighted combination of the terms below, in `[0, 1]`.
    pub score: f32,
    /// `score >= min_score()` **and** no hard veto fired.
    pub accept: bool,
    /// Corpus-statistical word-order plausibility (see module docs).
    pub fluency: f32,
    /// Geometric relatedness to the query.
    pub topicality: f32,
    /// Geometric anchoring in retrieved memory. `0.5` when no memory given.
    pub grounding: f32,
    /// Fraction of content words with real dictionary meanings.
    pub lexical: f32,
    /// Sentence-shape checks.
    pub structure: f32,
    /// Set when a hard rule rejected the candidate outright. When this is
    /// `Some`, `accept` is always `false` no matter how high `score` is.
    pub veto: Option<String>,
}

impl CoherenceVerdict {
    /// One-line audit trail.
    pub fn explain(&self) -> String {
        match &self.veto {
            Some(v) => format!(
                "REJECT[{}] score={:.2} flu={:.2} top={:.2} gnd={:.2} lex={:.2} str={:.2}",
                v, self.score, self.fluency, self.topicality, self.grounding, self.lexical,
                self.structure
            ),
            None => format!(
                "{} score={:.2} (bar {:.2}) flu={:.2} top={:.2} gnd={:.2} lex={:.2} str={:.2}",
                if self.accept { "ACCEPT" } else { "reject" },
                self.score,
                min_score(),
                self.fluency,
                self.topicality,
                self.grounding,
                self.lexical,
                self.structure
            ),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Individual terms
// ─────────────────────────────────────────────────────────────────────────────

/// Corpus-statistical plausibility of the word order, normalized against a
/// uniform-random baseline. See the module docs for the derivation.
///
/// Returns a neutral `0.5` — never a verdict — when there is nothing to judge
/// with: fewer than two tokens, or a lexicon with no priors built. "I cannot
/// tell" must not read as "this is bad", or an un-rebuilt lexicon would veto
/// every sentence KAI ever composed.
pub fn fluency(text: &str, lex: &StatLexicon) -> f32 {
    let toks = tokenize(text);
    if toks.len() < 2 {
        return 0.5;
    }
    let bg = lex.bigram();
    if bg.is_empty() {
        return 0.5;
    }
    let v = (bg.vocab_size.max(2)) as f32;
    let uniform = -(v.ln()); // ln(1/V), always negative
    if uniform >= 0.0 {
        return 0.5;
    }
    let tg = lex.trigram();

    let ids: Vec<Option<usize>> = toks.iter().map(|t| lex.word_id(t)).collect();
    let mut acc = 0.0f32;
    let mut n = 0usize;

    for i in 1..ids.len() {
        // Out-of-vocabulary words are scored at the uniform floor rather than
        // skipped. Skipping would let a sentence of pure gibberish score as
        // well as a sentence of two known words.
        let next = match ids[i] {
            Some(x) => x,
            None => {
                acc += uniform;
                n += 1;
                continue;
            }
        };
        let mut lp = bg.log_prob(ids[i - 1], next);
        if i >= 2 && !tg.is_empty() {
            let t = tg.log_prob(ids[i - 2], ids[i - 1], next);
            // `TrigramPrior::log_prob` returns exactly 0.0 to mean "no row for
            // this context", which as a log-prob would read as certainty.
            // Only blend a genuine (negative) observation.
            if t < 0.0 {
                lp = 0.5 * lp + 0.5 * t;
            }
        }
        acc += lp;
        n += 1;
    }

    if n == 0 {
        return 0.5;
    }
    let mean = acc / n as f32;
    ((mean - uniform) / -uniform).clamp(0.0, 1.0)
}

/// Fraction of content words that are real words KAI has actually encountered.
///
/// **Which dictionary is authoritative matters here, and getting it wrong is
/// dangerous.** The obvious choice — `semantic_dict`, the way
/// `voice::semantic_coherence_score` does it — carries only ~1k curated
/// entries. Ordinary English ("feeling", "processing", "clearly") is simply
/// absent from it, so a perfectly good sentence scores ~0.4 there. Vetoing on
/// that number would gag KAI on his own correct speech.
///
/// So the corpus vocabulary in `StatLexicon` is the authority: it is every
/// word KAI has read, tens of thousands of them, and "is this a word" is
/// exactly the question it can answer. `semantic_dict` is kept only as the
/// fallback for callers with no lexicon, and in that mode this score is never
/// allowed to veto — see `judge`.
pub fn lexical_validity(text: &str, lex: Option<&StatLexicon>) -> f32 {
    let words: Vec<&str> = text
        .split(|c: char| !c.is_alphabetic())
        .filter(|w| w.len() >= 3)
        .collect();
    if words.is_empty() {
        return 1.0;
    }
    if let Some(l) = lex {
        if !l.is_empty() {
            let known = words.iter().filter(|&&w| l.word_id(w).is_some()).count();
            return known as f32 / words.len() as f32;
        }
    }
    let known = words
        .iter()
        .filter(|&&w| {
            let b = crate::cognition::semantic_dict::lookup_word(w);
            b.pos != "unknown" && !b.definition.is_empty()
        })
        .count();
    known as f32 / words.len() as f32
}

/// Sentence-shape checks, averaged. Each is a property a real sentence has and
/// word salad usually lacks. Deliberately cheap and deliberately not
/// meaning-aware — meaning is `topicality`'s job.
pub fn structure(text: &str) -> f32 {
    let toks = tokenize(text);
    if toks.is_empty() {
        return 0.0;
    }
    let dict = crate::core::pos_dict::get_dictionary();
    let mut checks: Vec<f32> = Vec::with_capacity(5);

    // 1. Length in a plausible band for an utterance.
    checks.push(if (2..=45).contains(&toks.len()) { 1.0 } else { 0.0 });

    // 2. Contains at least one verb — the spine of a clause.
    let has_verb = toks
        .iter()
        .any(|t| dict.lookup(t).map(|e| e.pos == "verb").unwrap_or(false));
    checks.push(if has_verb { 1.0 } else { 0.0 });

    // 3. Type/token ratio — degenerate loops repeat the same few words.
    let mut uniq: Vec<&String> = toks.iter().collect();
    uniq.sort();
    uniq.dedup();
    let ttr = uniq.len() as f32 / toks.len() as f32;
    checks.push(ttr.clamp(0.0, 1.0));

    // 4. No run of three identical consecutive tokens.
    let mut run = 1usize;
    let mut worst_run = 1usize;
    for i in 1..toks.len() {
        if toks[i] == toks[i - 1] {
            run += 1;
            worst_run = worst_run.max(run);
        } else {
            run = 1;
        }
    }
    checks.push(if worst_run >= 3 { 0.0 } else { 1.0 });

    // 5. Terminal punctuation.
    let trimmed = text.trim_end();
    checks.push(if trimmed.ends_with('.') || trimmed.ends_with('!') || trimmed.ends_with('?') {
        1.0
    } else {
        0.0
    });

    checks.iter().sum::<f32>() / checks.len() as f32
}

/// Geometric relatedness between two strings in RSHL space.
fn cos_text(a: &str, b: &str) -> f32 {
    let va = SparseVec::encode(a);
    let vb = SparseVec::encode(b);
    va.cosine(&vb).clamp(0.0, 1.0)
}

/// Normalize for the parrot check: lowercase, alphanumeric-only, collapsed.
fn parrot_key(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .flat_map(|c| c.to_lowercase())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

// ─────────────────────────────────────────────────────────────────────────────
// The judge
// ─────────────────────────────────────────────────────────────────────────────

/// Score `candidate` as a reply to `query`.
///
/// * `memory` — vector of the retrieved cell the reply is supposed to be
///   grounded in, when there is one. Absent, `grounding` reports a neutral
///   `0.5` and its weight is redistributed across the other terms.
/// * `lex` — needed for `fluency`. Absent, `fluency` reports neutral `0.5`.
///
/// Hard vetoes fire before scoring and cannot be outvoted:
///   * empty / punctuation-only output,
///   * parroting the user's own words back,
///   * a run of three or more identical consecutive tokens,
///   * more than half the content words meaningless.
pub fn judge(
    candidate: &str,
    query: &str,
    memory: Option<&SparseVec>,
    lex: Option<&StatLexicon>,
) -> CoherenceVerdict {
    let cand = candidate.trim();

    let mut verdict = CoherenceVerdict {
        score: 0.0,
        accept: false,
        fluency: 0.5,
        topicality: 0.0,
        grounding: 0.5,
        lexical: 0.0,
        structure: 0.0,
        veto: None,
    };

    // ── Hard vetoes ─────────────────────────────────────────────────────────
    if cand.is_empty() || !cand.chars().any(|c| c.is_alphabetic()) {
        verdict.veto = Some("empty".into());
        return verdict;
    }
    if !query.trim().is_empty() && parrot_key(cand) == parrot_key(query) {
        verdict.veto = Some("parrot".into());
        return verdict;
    }

    let toks = tokenize(cand);
    let mut run = 1usize;
    for i in 1..toks.len() {
        if toks[i] == toks[i - 1] {
            run += 1;
            if run >= 3 {
                verdict.veto = Some("stuck-loop".into());
                return verdict;
            }
        } else {
            run = 1;
        }
    }

    // ── Scored terms ────────────────────────────────────────────────────────
    // Computed before any remaining veto so that `explain()` always reports
    // real measurements. An early return here used to emit zeros for terms
    // that were never measured, which reads in a log as "off-topic and
    // unstructured" when the truth is "not assessed".
    verdict.lexical = lexical_validity(cand, lex);
    verdict.fluency = lex.map(|l| fluency(cand, l)).unwrap_or(0.5);
    verdict.topicality = cos_text(cand, query);
    verdict.structure = structure(cand);
    if let Some(m) = memory {
        verdict.grounding = SparseVec::encode(cand).cosine(m).clamp(0.0, 1.0);
    }

    // Gibberish veto — only when a corpus lexicon was available to judge with.
    // Without one the fallback dictionary is far too small to be trusted with
    // a veto (see `lexical_validity`), so we score and let the bar decide.
    //
    // The >=3 content-word requirement is not a detail: on a one- or two-word
    // reply the "fraction of known words" is a sample of size one or two, so a
    // single out-of-vocabulary token drives it to 0.0 and vetoes the utterance.
    // That would silently kill every short, perfectly valid answer — "Yes.",
    // "I do.", "Not yet." — which are exactly the replies a conversational
    // system needs most. Short output is judged on the scored bar instead.
    let content_words = cand
        .split(|c: char| !c.is_alphabetic())
        .filter(|w| w.len() >= 3)
        .count();
    if lex.is_some() && content_words >= 3 && verdict.lexical < 0.25 {
        verdict.veto = Some("gibberish".into());
        return verdict;
    }

    // Weights. `grounding` only participates when a memory anchor was
    // supplied; otherwise its weight is redistributed so an ungrounded reply
    // is not silently penalised for a channel that was never available.
    let (w_flu, w_top, w_str, w_lex, w_gnd) = if memory.is_some() {
        (0.35f32, 0.25f32, 0.20f32, 0.10f32, 0.10f32)
    } else {
        (0.39f32, 0.28f32, 0.22f32, 0.11f32, 0.00f32)
    };

    verdict.score = (w_flu * verdict.fluency
        + w_top * verdict.topicality
        + w_str * verdict.structure
        + w_lex * verdict.lexical
        + w_gnd * verdict.grounding)
        .clamp(0.0, 1.0);

    verdict.accept = verdict.score >= min_score();
    verdict
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — these are the calibration evidence.
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Build a small but *real* lexicon from a synthetic corpus, so the
    /// fluency term is exercised against genuine bigram/trigram counts rather
    /// than a stub. Repetition is deliberate: the priors need to have actually
    /// observed these transitions for the score to mean anything.
    fn tiny_lexicon() -> StatLexicon {
        // Each caller gets its OWN corpus file. All four tests that use this
        // helper previously shared one path, and cargo runs tests in parallel
        // threads — so one test could be reading the file while another was
        // still writing it, yielding a truncated corpus and a flaky failure.
        tiny_lexicon_named(&format!(
            "{:?}",
            std::thread::current().id()
        ))
    }

    fn tiny_lexicon_named(tag: &str) -> StatLexicon {
        const CORPUS: &str = "\
i am feeling good and the lattice is processing clearly
i understand what you are saying to me
the lattice is processing clearly and i am grounded
i am feeling good today and i am listening
what you are saying to me is clear
the lattice stores meaning as geometry
i am kai and i am built on the lattice
you are asking me how i am feeling
i am processing the question clearly
the meaning is stored in the lattice
";
        let path = std::env::temp_dir().join(format!("kai_coherence_corpus_{}.txt", tag.replace(|c:char| !c.is_alphanumeric(), "_")));
        {
            let mut f = std::fs::File::create(&path).expect("create temp corpus");
            // Repeat the corpus so transition counts rise well above the
            // Laplace smoothing floor.
            for _ in 0..12 {
                f.write_all(CORPUS.as_bytes()).expect("write temp corpus");
            }
        }
        StatLexicon::build_from_paths(&[&path]).expect("build lexicon")
    }

    #[test]
    fn empty_is_vetoed() {
        let v = judge("   ", "who are you?", None, None);
        assert!(!v.accept);
        assert_eq!(v.veto.as_deref(), Some("empty"));
    }

    #[test]
    fn parroting_the_user_is_vetoed() {
        let v = judge("Who are you?", "who are you?", None, None);
        assert!(!v.accept);
        assert_eq!(v.veto.as_deref(), Some("parrot"));
    }

    #[test]
    fn stuck_loop_is_vetoed() {
        let v = judge(
            "the lattice lattice lattice is processing.",
            "how are you?",
            None,
            None,
        );
        assert!(!v.accept);
        assert_eq!(v.veto.as_deref(), Some("stuck-loop"));
    }

    /// Structure must separate a well-formed sentence from a degenerate one
    /// even with no lexicon present.
    #[test]
    fn structure_prefers_real_sentences() {
        let good = structure("I understand what you are saying to me.");
        let bad = structure("lattice lattice lattice lattice");
        assert!(
            good > bad,
            "structure should rank a sentence above a repeat loop: {good} vs {bad}"
        );
        assert!(good >= 0.6, "well-formed sentence scored low: {good}");
    }

    /// Topicality is geometric, so an on-topic reply must beat an off-topic one.
    #[test]
    fn topicality_tracks_the_question() {
        let q = "what is the lattice?";
        let on = judge("The lattice stores meaning as geometry.", q, None, None);
        let off = judge("Bananas ripen quickly in warm weather.", q, None, None);
        assert!(
            on.topicality > off.topicality,
            "on-topic {:.3} should beat off-topic {:.3}",
            on.topicality,
            off.topicality
        );
    }

    /// **The headline claim.** A coherent reply must outscore scrambled words
    /// drawn from the *same* vocabulary. Identical bag of words, different
    /// order — so `topicality` (a bag-of-features cosine), `lexical`, and the
    /// length/verb/TTR checks are all essentially tied. Only the word-order
    /// terms can separate them. This is the test that proves the critic
    /// judges *structure*, not just vocabulary.
    #[test]
    fn coherent_beats_scrambled_same_words() {
        let lex = tiny_lexicon();
        let q = "how are you feeling?";
        let good = judge(
            "i am feeling good and the lattice is processing clearly.",
            q,
            None,
            Some(&lex),
        );
        let salad = judge(
            "processing lattice good the is feeling and clearly am i.",
            q,
            None,
            Some(&lex),
        );
        assert!(
            good.fluency > salad.fluency,
            "fluency must separate word order\n  good:  {}\n  salad: {}",
            good.explain(),
            salad.explain()
        );
        assert!(
            good.score > salad.score,
            "coherent {:.3} must beat salad {:.3}\n  good:  {}\n  salad: {}",
            good.score,
            salad.score,
            good.explain(),
            salad.explain()
        );
    }

    /// The bar must actually be usable: real speech clears it, salad does not.
    /// If this ever fails, `DEFAULT_MIN_SCORE` is miscalibrated and the critic
    /// would either gag KAI or wave everything through.
    #[test]
    fn threshold_admits_speech_and_blocks_salad() {
        let lex = tiny_lexicon();
        let q = "how are you feeling?";
        let good = judge(
            "i am feeling good and the lattice is processing clearly.",
            q,
            None,
            Some(&lex),
        );
        let salad = judge(
            "processing lattice good the is feeling and clearly am i.",
            q,
            None,
            Some(&lex),
        );
        assert!(good.accept, "real speech must clear the bar: {}", good.explain());
        assert!(!salad.accept, "salad must not clear the bar: {}", salad.explain());
    }

    /// Regression guard for the miscalibration this module was born with: the
    /// ~1k-entry `semantic_dict` scores ordinary English around 0.4, so using
    /// it as veto authority rejected KAI's own correct sentences as
    /// "gibberish". The corpus lexicon must be the authority.
    #[test]
    fn ordinary_english_is_not_gibberish() {
        let lex = tiny_lexicon();
        let v = judge(
            "i am feeling good and the lattice is processing clearly.",
            "how are you?",
            None,
            Some(&lex),
        );
        assert!(
            v.veto.is_none(),
            "correct speech must not be vetoed: {}",
            v.explain()
        );
        assert!(
            v.lexical > 0.9,
            "corpus words should be recognised, got {:.2}",
            v.lexical
        );
    }

    /// A neutral verdict when the lexicon is missing must not become a veto —
    /// otherwise an un-rebuilt lexicon silences KAI entirely.
    #[test]
    fn missing_lexicon_is_neutral_not_fatal() {
        let v = judge(
            "I understand what you are saying to me.",
            "do you understand?",
            None,
            None,
        );
        assert_eq!(v.fluency, 0.5, "absent lexicon must read neutral");
        assert!(v.veto.is_none());
    }

    #[test]
    fn grounding_rewards_memory_anchored_replies() {
        let mem = SparseVec::encode("KAI is built on the RSHL lattice architecture");
        let anchored = judge(
            "I am KAI, built on the RSHL lattice architecture.",
            "who are you?",
            Some(&mem),
            None,
        );
        let unanchored = judge(
            "I am KAI, built on the RSHL lattice architecture.",
            "who are you?",
            None,
            None,
        );
        assert!(
            anchored.grounding > 0.1,
            "anchored reply should show grounding, got {:.3}",
            anchored.grounding
        );
        assert_eq!(unanchored.grounding, 0.5, "absent memory must read neutral");
    }

    /// Short answers are the ones a conversation needs most, and they are the
    /// ones a "fraction of known words" veto destroys first — one unknown
    /// token out of one is a score of 0.0. They must never be vetoed.
    #[test]
    fn short_valid_replies_survive() {
        let lex = tiny_lexicon();
        for s in ["yes.", "i am.", "not yet.", "no."] {
            let v = judge(s, "are you listening?", None, Some(&lex));
            assert!(
                v.veto.is_none(),
                "short reply was vetoed: {:?} -> {}",
                s,
                v.explain()
            );
        }
    }

    /// Prints the calibration table. Not an assertion — run with
    /// `cargo test --lib coherence::tests::calibration_report -- --nocapture`
    /// when re-tuning weights or `DEFAULT_MIN_SCORE`, so the numbers behind a
    /// threshold change are on the record instead of guessed at.
    #[test]
    fn calibration_report() {
        let lex = tiny_lexicon();
        let q = "how are you feeling?";
        let cases: &[(&str, &str)] = &[
            ("fluent + on-topic", "i am feeling good and the lattice is processing clearly."),
            ("fluent, off-topic", "the meaning is stored in the lattice."),
            ("scrambled same words", "processing lattice good the is feeling and clearly am i."),
            ("stuck loop", "lattice lattice lattice is processing."),
            ("out-of-vocabulary", "zorp frimble gnasty vorplex quibbet."),
            ("too short", "yes."),
        ];
        println!("\n  bar = {:.2}   (vocab {} words)", min_score(), lex.len());
        for (name, text) in cases {
            println!("  {:<22} {}", name, judge(text, q, None, Some(&lex)).explain());
        }
        println!();
    }

    /// **Live-lexicon evidence.** Loads the real `data/stat-lexicon.json`,
    /// runs the real decoder, and judges what actually comes out. This is the
    /// test that answers "would the critic help or hurt KAI in production" —
    /// the synthetic fixtures above only prove the math is sound.
    ///
    /// `#[ignore]` because it depends on a 10 MB data file and takes seconds.
    /// Run explicitly:
    /// `cargo test --lib coherence::tests::real_lexicon_decode -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_lexicon_decode() {
        use crate::core::stat_lexicon::DecodeParams;

        let path = "data/stat-lexicon.json";
        let lex = match StatLexicon::load(path) {
            Ok(l) => l,
            Err(e) => {
                println!("  SKIP: {} unavailable ({e})", path);
                return;
            }
        };
        println!(
            "\n  lexicon: {} words · bigram_empty={} · trigram_empty={}",
            lex.len(),
            lex.bigram().is_empty(),
            lex.trigram().is_empty()
        );
        println!("  bar = {:.2}\n", min_score());

        let prompts = [
            "who are you",
            "how are you feeling today",
            "what is the lattice",
            "do you understand what i am saying",
        ];
        let mut accepted = 0usize;
        for p in prompts {
            // Same decoder settings the live voice path uses, minus the
            // Universe-derived state (encode_sentence is the documented
            // fallback when no memory channel is available).
            let state = lex.encode_sentence(p);
            for attempt in 0..attempts() {
                let params = DecodeParams {
                    max_tokens: 12,
                    temperature: 0.7,
                    top_k: 16,
                    repetition_window: 8,
                    repetition_penalty: 1.2,
                    stop_on_immediate_repeat: true,
                    bigram_weight: 0.6,
                    trigram_weight: 0.6,
                    attention_weight: 1.0,
                    seed: 0xC0FFEE_u64
                        .wrapping_add(0x9E3779B97F4A7C15u64.wrapping_mul(attempt as u64)),
                    context_injects: Default::default(),
                    clause_aware_stop: true,
                    expected_pos_sequence: None,
                    sentence_type: None,
                };
                let out = lex.incremental_generate_with(state.clone(), params);
                let v = judge(&out, p, None, Some(&lex));
                println!("  q={:?}\n    a={:?}\n    {}", p, out.trim(), v.explain());
                if v.accept {
                    accepted += 1;
                    break;
                }
            }
        }
        println!(
            "\n  {}/{} prompts produced an utterance the critic would let through.\n",
            accepted,
            prompts.len()
        );
    }

    #[test]
    fn flag_defaults_off() {
        // Guards the "default OFF = byte-identical old behavior" contract.
        // Only meaningful when the env var is unset in the test environment.
        if std::env::var("KAI_COHERENCE_CRITIC").is_err() {
            assert!(!enabled());
        }
    }
}
