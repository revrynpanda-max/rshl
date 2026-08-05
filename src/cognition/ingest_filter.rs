//! # Ingest gate — stop KAI learning his own rejected output.
//!
//! ## The loop this closes
//!
//! `voice::is_bad_output` already knows that a string starting with
//! `"Reasoning for"`, or containing `"(Source:"` / `"Language sample"` /
//! `"[MIRROR]"`, is a corpus artifact and must never reach a user. But that
//! function is private to `voice.rs` and is only ever called on the **output**
//! path. Nothing equivalent guarded **ingest**.
//!
//! Meanwhile `overnight_pipeline.py` manufactures exactly that shape —
//!
//! ```text
//!   "text": f"Reasoning for '{question}': {reasoning_safe}"
//! ```
//!
//! — and POSTs it to `/api/bulk-ingest`, whose entire validation was
//! `if entry.text.trim().is_empty() { continue; }`. `Universe::store_or_reinforce`
//! then sets `label: text.to_string()`, so the artifact string *becomes a cell
//! label*. And cell labels are precisely what the synaptogenesis loop draws its
//! seeds from. So every night KAI wired his own filtered-out garbage into the
//! lattice as if it were knowledge, and the continuous-research loop fed those
//! same labels back out as literal web-search topics.
//!
//! That is a closed positive-feedback loop, and it is the reason the observed
//! seed stream is full of `"Reasoning for '...'"`, `"Machine learning is machine
//! learning is machine learning"`, and raw `[src:user:...|holder:...]` headers.
//!
//! ## Why the existing label filter did not catch it
//!
//! `is_junk_concept_label` rejects any label with `": "` in the **first 40
//! characters**. That catches `"Leo: hi"`. It does not catch
//!
//! ```text
//!   Reasoning for 'What is the function of red blood cells?': Th...
//!                                                           ^ colon at ~55
//! ```
//!
//! because the embedded question pushes the colon past the window. The filter
//! had a length-dependent blind spot, and KAI's own artifacts are exactly the
//! shape that defeats it.
//!
//! ## Scope — deliberately conservative
//!
//! This rejects only things that are *unambiguously* machine artifacts or
//! structurally degenerate. It does NOT try to judge whether a claim is true,
//! well-written, or on-topic — that is `cognition::coherence`'s job, and
//! applying it here would silently discard legitimate knowledge. A gate on the
//! learning path should have a very low false-positive rate; better to admit a
//! mediocre fact than to reject a good one.
//!
//! Enabled by default. Set `KAI_INGEST_GATE=0` to restore the old
//! accept-everything behaviour.

/// Outcome of judging one candidate ingest string.
#[derive(Debug, Clone, PartialEq)]
pub struct IngestVerdict {
    pub accept: bool,
    /// Short machine-readable reason when rejected, for logging and metrics.
    pub reason: Option<&'static str>,
}

impl IngestVerdict {
    fn ok() -> Self {
        IngestVerdict { accept: true, reason: None }
    }
    fn reject(reason: &'static str) -> Self {
        IngestVerdict { accept: false, reason: Some(reason) }
    }
}

/// Is the gate active? `KAI_INGEST_GATE=0` disables it.
///
/// Default ON, unlike most flags in this codebase, because the *current*
/// behaviour is the bug: accepting strings the engine elsewhere declares to be
/// garbage. Leaving it off by default would mean the poisoning continues until
/// somebody remembers to set a variable.
pub fn enabled() -> bool {
    match std::env::var("KAI_INGEST_GATE") {
        Ok(v) => v != "0" && !v.eq_ignore_ascii_case("false") && !v.eq_ignore_ascii_case("off"),
        Err(_) => true,
    }
}

/// Machine-artifact markers. These mirror `voice::is_bad_output`'s
/// ingest/corpus-artifact section — the same strings the engine already refuses
/// to *say*, now also refused as things to *learn*.
const ARTIFACT_PREFIXES: &[&str] = &[
    "reasoning for",
    "language sample",
    "system anchor:",
    "original:",
    "fixed:",
    "basedon the context provided",
    "based on the context provided in the code snippet",
];

const ARTIFACT_SUBSTRINGS: &[&str] = &[
    "reasoning for '",
    "(source:",
    "grammar correction:",
    "kai raw sentence",
    // NOT an artifact — a "[MIRROR] …" cell is a deliberate opposite-perspective
    // twin that `Universe::store_or_reinforce` spawns with `vec.invert()` for any
    // cell of strength >= 4.0 (universe.rs:1275-1284). It is listed here because
    // such a cell must only ever be BORN internally: ingesting the label through
    // the API would create it with a normal, non-inverted vector and quietly
    // break the mirror-neuron mechanism. Note this rule costs nothing today —
    // mirrors are spawned downstream of this gate and so never pass through it.
    "[mirror]",
    "[js-drive-sync]",
    "unrelated distractors from the kai memory palace",
    "ai speaker leo",
    "ryan [voice]:",
    "**(thinking",
    "(thinking...",
];

/// Judge a candidate string for ingestion into the lattice.
pub fn judge_ingest(text: &str) -> IngestVerdict {
    let trimmed = text.trim();

    if trimmed.len() < 8 {
        return IngestVerdict::reject("too-short");
    }
    if !trimmed.chars().any(|c| c.is_alphabetic()) {
        return IngestVerdict::reject("no-letters");
    }

    let lower = trimmed.to_lowercase();

    for p in ARTIFACT_PREFIXES {
        if lower.starts_with(p) {
            return IngestVerdict::reject("kai-artifact");
        }
    }
    for s in ARTIFACT_SUBSTRINGS {
        if lower.contains(s) {
            return IngestVerdict::reject("kai-artifact");
        }
    }

    // Raw provenance headers, e.g.
    //   "[src:user:usr_6e6932d1ec1fc7d3|holder:synced-ai|provider:anthropic...]"
    // These carry no concept at all and were invisible to the old `": "` filter
    // because their colons have no following space.
    if lower.starts_with("[src:") || (lower.contains("|holder:") && lower.contains("|provider:")) {
        return IngestVerdict::reject("raw-metadata");
    }

    // Telemetry dumps.
    if (lower.contains("pain=") && lower.contains("fatigue=")) || lower.contains("pred_err=") {
        return IngestVerdict::reject("telemetry");
    }

    if is_degenerate_repeat(&lower) {
        return IngestVerdict::reject("degenerate-repeat");
    }
    if has_duplicated_sentence(trimmed) {
        return IngestVerdict::reject("duplicated-sentence");
    }

    IngestVerdict::ok()
}

/// Detects the `"Machine learning is machine learning is machine learning"`
/// failure mode — a decoder that fell into a loop and produced text which is
/// grammatical locally but carries one word of information.
///
/// Two independent signals, either of which is conclusive:
///   * some 3-gram occurs 3+ times, or
///   * the type/token ratio collapses on a long-enough sample.
fn is_degenerate_repeat(lower: &str) -> bool {
    // Punctuation MUST be stripped before counting. Splitting on whitespace
    // alone makes "learning." and "learning" distinct tokens, which is exactly
    // enough to hide a real loop: the observed seed
    //   "Machine learning is machine learning. It is machine learning is machine learning"
    // topped out at 2 identical 3-grams instead of 3 purely because of one full
    // stop, and slipped through.
    // Symbolic / mathematical content is exempt. Measured against the live
    // lattice, the naive version of this check rejected 1,867 real cells —
    // truth tables ("T & T = T  T & F = F  F & T = F"), calculus
    // ("f(x)/g(x)"), and LaTeX ("$$x^{2}=\mu^{2}v^{2}$$") all repeat tokens as
    // a matter of NOTATION, not because a decoder looped. Repetition simply is
    // not evidence of degeneracy in that register, so don't judge it here.
    if looks_symbolic(lower) {
        return false;
    }

    // Keep EVERY alphanumeric token. An earlier version dropped numbers and
    // single letters, which was worse than useless: removing them fused tokens
    // that are not actually adjacent. In
    //   "1 (which is 1*1), 4 (which is 2*2), 9 (which is 3*3)"
    // dropping the digits collapses the text to "which is which is which is",
    // a loop that does not exist. Measured on the live lattice, that alone
    // accounted for most of the false positives. With the numbers kept, the
    // 3-grams are (which,is,1), (which,is,2), (which,is,4) — all distinct.
    let words: Vec<&str> = lower
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    if words.len() < 9 {
        return false;
    }

    // Repeated 3-gram — but COUNT ALONE IS NOT ENOUGH. Legitimate enumeration
    // ("the first few square numbers are …") repeats a frame while the content
    // varies, and a decoder loop repeats the whole utterance. What separates
    // them is how much of the text the repeat actually covers: near-total for a
    // loop, partial for enumeration. So require both a repeat and majority
    // coverage.
    let mut counts: std::collections::HashMap<(&str, &str, &str), usize> =
        std::collections::HashMap::new();
    let mut best = 0usize;
    for w in words.windows(3) {
        let e = counts.entry((w[0], w[1], w[2])).or_insert(0);
        *e += 1;
        if *e > best {
            best = *e;
        }
    }
    if best >= 3 && (best * 3) as f32 / (words.len() as f32) > 0.5 {
        return true;
    }

    // Type/token collapse. 0.32 is deliberately low so that ordinary prose —
    // which repeats articles and prepositions constantly — is never caught.
    if words.len() >= 14 {
        let mut uniq: Vec<&str> = words.clone();
        uniq.sort_unstable();
        uniq.dedup();
        if (uniq.len() as f32) / (words.len() as f32) < 0.32 {
            return true;
        }
    }
    false
}

/// True when the text reads as mathematical / symbolic notation rather than
/// prose. Used to exempt it from the repetition heuristics, which assume prose.
fn looks_symbolic(lower: &str) -> bool {
    // Explicit LaTeX / formula markers.
    for m in ["$$", "\\frac", "^{", "_{", "\\mu", "\\sum", "\\int", "\\cos", "\\sin"] {
        if lower.contains(m) {
            return true;
        }
    }
    // Or simply a high density of operators and delimiters.
    let total = lower.chars().filter(|c| !c.is_whitespace()).count();
    if total < 20 {
        return false;
    }
    let symbols = lower
        .chars()
        .filter(|c| matches!(c, '=' | '*' | '&' | '|' | '^' | '<' | '>' | '+' | '/' | '\\' | '{' | '}' | '$'))
        .count();
    (symbols as f32) / (total as f32) > 0.08
}

/// Detects text that is the same sentence concatenated with itself, e.g.
/// `"Ice floats on water because it is lighter than water.Ice floats on water
/// because it is lighter than water."` — a real observed seed.
fn has_duplicated_sentence(text: &str) -> bool {
    let sentences: Vec<String> = text
        .split(|c| c == '.' || c == '!' || c == '?')
        .map(|s| s.trim().to_lowercase())
        .filter(|s| s.len() >= 20)
        .collect();
    if sentences.len() < 2 {
        return false;
    }
    for i in 0..sentences.len() {
        for j in (i + 1)..sentences.len() {
            if sentences[i] == sentences[j] {
                return true;
            }
        }
    }
    false
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — the fixtures are REAL strings observed in the live synaptogenesis log.
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Every one of these was actually seeded into the lattice, verbatim.
    #[test]
    fn rejects_real_observed_garbage() {
        let cases: &[(&str, &str)] = &[
            (
                "Reasoning for 'What is the function of red blood cells?': They carry oxygen.",
                "kai-artifact",
            ),
            (
                "Machine learning is machine learning. It is machine learning is machine learning",
                "degenerate-repeat",
            ),
            (
                "[src:user:usr_6e6932d1ec1fc7d3|holder:synced-ai|provider:anthropic|x]",
                "raw-metadata",
            ),
            (
                "Ice floats on water because it is lighter than water.Ice floats on water because it is lighter than water.",
                "duplicated-sentence",
            ),
            ("short", "too-short"),
            (
                "Language sample (conversational): hello there friend how are you",
                "kai-artifact",
            ),
            (
                "System Anchor: There is an implicit structural correlation between the cells",
                "kai-artifact",
            ),
        ];
        for (text, want) in cases {
            let v = judge_ingest(text);
            assert!(!v.accept, "should have been rejected: {:?}", text);
            assert_eq!(v.reason, Some(*want), "wrong reason for {:?}", text);
        }
    }

    /// The far more important direction: a gate on the LEARNING path must not
    /// throw away real knowledge. Every one of these must pass.
    #[test]
    fn accepts_legitimate_knowledge() {
        let good = [
            "Gravity is a force that pulls objects towards the ground.",
            "The difference between weather and climate is that weather refers to short-term conditions.",
            "In linguistics, generative grammar is a way of understanding how sentences are built.",
            "The engine requires a non-empty user_id on private regions to apply LAYER_CELLULAR.",
            "A prime number is a natural number greater than 1 with no positive divisors other than 1 and itself.",
            "The suffix -ity is added to the end of adjectives to form nouns.",
            "Paris is the capital of France.",
            "When explicit memory connections are lacking, KAI uses A* search to find a path.",
            "Red blood cells carry oxygen from the lungs to the rest of the body.",
            "The water cycle is a process where water moves through the Earth's atmosphere.",
        ];
        for g in good {
            let v = judge_ingest(g);
            assert!(v.accept, "false positive — rejected {:?} as {:?}", g, v.reason);
        }
    }

    /// `"-1, 0, and 1"` is DELIBERATELY admitted, even though it looks like a
    /// fragment. It is the value set of KAI's own ternary weights, and the
    /// lattice already holds the related cell "The specific values used for the
    /// ternary weights are -1, 0, ...". When the live log showed this seed
    /// producing 0 bridges, that was a *retrieval* failure on a real concept —
    /// not noise correctly rejected. A gate on the learning path must not
    /// "fix" that by deleting the concept.
    #[test]
    fn short_but_meaningful_fragments_are_admitted() {
        let v = judge_ingest("-1, 0, and 1");
        assert!(v.accept, "rejected a real concept as {:?}", v.reason);
    }

    /// Regression guard from the live-lattice measurement: these are REAL cells
    /// the first version of the repetition rule rejected. Mathematical notation
    /// repeats tokens by design, and a learning gate that eats the maths is
    /// worse than no gate at all.
    #[test]
    fn mathematical_notation_survives() {
        let maths = [
            "Symbolically, this corresponds to: * T & T = T * T & F = F * F & T = F * F & F = F",
            "To achieve this, recall that the quotient rule states that if z = f(x)/g(x), then dz/dx = (f'g - fg')/g^2",
            "Squaring both equations leads to: $$x^{2}=\\mu^{2}v^{2}\\cos^{2}\\phi$$ $$y^{2}=\\mu^{2}v^{2}\\sin^{2}\\phi$$",
            "For all x: x + 0 = x, x * 1 = x, x * 0 = 0, x + (-x) = 0",
            // Second round of live-lattice false positives: legitimate
            // enumeration repeats a frame while the content varies.
            "The first few square numbers are 1 (which is 1*1), 4 (which is 2*2), 9 (which is 3*3), 16 (which is 4*4)",
            "Thus, for the prime factorization of 540, we arrive at the expression: 540 = 2 squared times 3 cubed times 5",
            "If a transfer function is analytic in the exterior of the unit circle, then there are no poles outside it",
        ];
        for m in maths {
            let v = judge_ingest(m);
            assert!(v.accept, "rejected maths as {:?}: {:?}", v.reason, m);
        }
    }

    /// Ordinary prose repeats function words heavily. The type/token check must
    /// not mistake that for a decoder loop.
    #[test]
    fn ordinary_prose_survives_repetition_checks() {
        let prose = "The cell is the basic unit of life and the cell contains the nucleus \
                     and the nucleus holds the genetic material of the organism in question";
        let v = judge_ingest(prose);
        assert!(v.accept, "ordinary prose rejected as {:?}", v.reason);
    }

    /// A single repeated phrase twice is not conclusive; three times is.
    #[test]
    fn repeat_threshold_is_three_not_two() {
        let twice = "the lattice stores meaning and the lattice stores knowledge for later recall";
        assert!(judge_ingest(twice).accept, "two repeats should be tolerated");
        let thrice = "the lattice stores meaning the lattice stores meaning the lattice stores meaning";
        assert!(!judge_ingest(thrice).accept, "three repeats should be rejected");
    }

    /// **Live-lattice impact measurement.** Loads the real persisted brain and
    /// reports what fraction of existing cell labels this gate would reject,
    /// with a breakdown by reason and samples of each.
    ///
    /// This is the number that decides whether the gate is safe to turn on: a
    /// few percent means it is removing artifacts, a large fraction means it is
    /// eating the lattice and the rules are wrong. Run before deploying:
    /// `cargo test --release --lib ingest_filter::tests::live_lattice_impact -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_lattice_impact() {
        let base = std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".into());
        let loaded = crate::persistence::load(&base);
        let (universe, ..) = match loaded {
            Some(t) => t,
            None => {
                println!("  SKIP: no persisted universe under {}", base);
                return;
            }
        };
        let cells = universe.cells();
        let total = cells.len();
        println!("\n  cells loaded: {}", total);
        if total == 0 {
            return;
        }

        let mut by_reason: std::collections::HashMap<&'static str, usize> =
            std::collections::HashMap::new();
        let mut samples: std::collections::HashMap<&'static str, Vec<String>> =
            std::collections::HashMap::new();
        let mut rejected = 0usize;

        for c in cells.iter() {
            let v = judge_ingest(&c.label);
            if !v.accept {
                rejected += 1;
                let r = v.reason.unwrap_or("unknown");
                *by_reason.entry(r).or_insert(0) += 1;
                let s = samples.entry(r).or_default();
                if s.len() < 3 {
                    s.push(c.label.chars().take(90).collect());
                }
            }
        }

        let pct = (rejected as f64) * 100.0 / (total as f64);
        println!("  would reject: {} / {} ({:.2}%)\n", rejected, total, pct);
        let mut reasons: Vec<(&&'static str, &usize)> = by_reason.iter().collect();
        reasons.sort_by(|a, b| b.1.cmp(a.1));
        for (reason, n) in reasons {
            let rp = (*n as f64) * 100.0 / (total as f64);
            println!("  {:<22} {:>7}  ({:.2}%)", reason, n, rp);
            for s in samples.get(*reason).map(|v| v.as_slice()).unwrap_or(&[]) {
                println!("        {:?}", s);
            }
        }
        println!();
    }

    #[test]
    fn gate_is_on_by_default() {
        if std::env::var("KAI_INGEST_GATE").is_err() {
            assert!(enabled(), "the ingest gate must default ON");
        }
    }
}
