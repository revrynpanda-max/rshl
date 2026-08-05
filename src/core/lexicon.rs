//! Lexicon — KAI's Vocabulary Backbone
//!
//! Loads 10,000 common English words from the google-10000-english-usa.txt file.
//! Provides:
//!   - Word recognition: O(1) lookup to check if a word is known
//!   - Spelling correction: Edit-distance based fuzzy matching
//!   - Frequency awareness: Words ranked by commonality (rank 0 = "the", most common)
//!   - Dream seeding: Random word selection for dream-state exploration
//!
//! The lexicon is KAI's "tongue" — it lets him understand what the user
//! MEANT to say, not just what they typed. A misspelled word gets pulled
//! to the nearest known form by mathematical distance, weighted by how
//! common that word is in English.
//!
//! This is pure math: edit distance is the resonance between character
//! sequences, and frequency rank is the gravitational pull of common usage.
use std::collections::HashMap;
use std::sync::OnceLock;

/// The raw word list, embedded at compile time.
/// No file I/O at runtime — the words are baked into the binary.
const WORD_LIST: &str = include_str!("../../data/google-10000-english-usa.txt");

/// Maximum edit distance to consider for spelling correction.
/// Distance 2 catches most typos (swapped letters, missing letter, extra letter).
const MAX_EDIT_DISTANCE: usize = 2;

/// A loaded, indexed vocabulary.
pub struct Lexicon {
    /// word → frequency rank (0 = most common)
    words: HashMap<String, usize>,
    /// Ordered list for random access by rank
    ordered: Vec<String>,
    /// Lazily-built basis table: every lexicon word paired with its encoded
    /// `SparseVec`. Building it costs ~10k `SparseVec::encode` calls, so it is
    /// computed on first use and reused for every subsequent decode.
    /// Invalidated by `add_word`.
    basis: OnceLock<Vec<(String, super::SparseVec)>>,
}

impl Lexicon {
    /// Load the lexicon from the embedded word list.
    pub fn load() -> Self {
        let mut words = HashMap::new();
        let mut ordered = Vec::new();

        for (rank, line) in WORD_LIST.lines().enumerate() {
            let word = line.trim().to_lowercase();
            if word.is_empty() {
                continue;
            }
            if !words.contains_key(&word) {
                words.insert(word.clone(), rank);
                ordered.push(word);
            }
        }

        Self {
            words,
            ordered,
            basis: OnceLock::new(),
        }
    }

    /// Build a lexicon from an explicit word list, ranked in the order given.
    ///
    /// Used by tests and benchmarks that need a small, fully-controlled
    /// vocabulary instead of the 10k embedded list.
    pub fn from_words<S: AsRef<str>>(list: &[S]) -> Self {
        let mut words = HashMap::new();
        let mut ordered = Vec::new();
        for (rank, w) in list.iter().enumerate() {
            let word = w.as_ref().trim().to_lowercase();
            if word.is_empty() {
                continue;
            }
            if !words.contains_key(&word) {
                words.insert(word.clone(), rank);
                ordered.push(word);
            }
        }
        Self {
            words,
            ordered,
            basis: OnceLock::new(),
        }
    }

    /// Check if a word is known.
    #[inline]
    pub fn is_known(&self, word: &str) -> bool {
        self.words.contains_key(&word.to_lowercase())
    }

    /// Get the frequency rank of a word (0 = most common).
    /// Returns None if the word is unknown.
    pub fn rank(&self, word: &str) -> Option<usize> {
        self.words.get(&word.to_lowercase()).copied()
    }

    /// Add a word to the lexicon at runtime (used when user teaches KAI a new word).
    /// The word gets a high rank number (rare) so it doesn't override common words.
    pub fn add_word(&mut self, word: &str) {
        let lower = word.to_lowercase();
        if !self.words.contains_key(&lower) {
            let rank = self.ordered.len() + 100_000; // rare rank — won't beat common words
            self.words.insert(lower.clone(), rank);
            self.ordered.push(lower);
            // The cached basis table no longer covers the vocabulary — drop it
            // so the next decode rebuilds it including the new word.
            self.basis = OnceLock::new();
        }
    }

    /// Total number of words in the lexicon.
    pub fn len(&self) -> usize {
        self.ordered.len()
    }

    /// Get a word by its frequency rank.
    pub fn word_at_rank(&self, rank: usize) -> Option<&str> {
        self.ordered.get(rank).map(|s| s.as_str())
    }

    /// Pick a random word from the lexicon.
    pub fn random_word(&self) -> &str {
        use rand::Rng;
        let mut rng = rand::thread_rng();
        let idx = rng.gen_range(0..self.ordered.len());
        &self.ordered[idx]
    }

    /// Pick a random word, biased toward less common words (for dream exploration).
    /// Uses the square of a random float to bias toward higher ranks (rarer words).
    pub fn random_rare_word(&self) -> &str {
        use rand::Rng;
        let mut rng = rand::thread_rng();
        let bias: f32 = rng.gen::<f32>().powi(2); // squared = biased toward 1.0 = rare
        let idx = (bias * self.ordered.len() as f32) as usize;
        let clamped = idx.min(self.ordered.len() - 1);
        &self.ordered[clamped]
    }

    /// Correct a misspelled word. Returns Some(corrected) if the word is
    /// unknown and a close match exists, None if the word is already known
    /// or no correction is found within MAX_EDIT_DISTANCE.
    ///
    /// When multiple candidates tie on edit distance, the one with the
    /// lower frequency rank (more common) wins.
    pub fn correct(&self, word: &str) -> Option<String> {
        let lower = word.to_lowercase();

        // Already known — no correction needed
        if self.words.contains_key(&lower) {
            return None;
        }

        // Too short to meaningfully correct
        if lower.len() < 3 {
            return None;
        }

        // Contractions and possessives — never "correct" what's, it's, I'm, Ryan's, etc.
        // An apostrophe means the word is intentional shorthand, not a typo.
        if lower.contains('\'') || lower.contains('\u{2019}') {
            return None;
        }

        // Use stricter distance for short words — prevents "curse" → "course",
        // "bitch" → "batch", etc. Informal/slang words are often short and close
        // to real words by edit distance but are intentional.
        let max_dist = if lower.len() <= 5 {
            1
        } else {
            MAX_EDIT_DISTANCE
        };

        let result = self.find_closest(&lower, max_dist)?;

        // Reject correction if result is SHORTER than original by more than 1 char —
        // that's suffix-stripping (bitchy→bitch), not a typo fix.
        if result.len() + 1 < lower.len() {
            return None;
        }

        Some(result)
    }

    /// Get multiple spelling suggestions for a word, sorted by
    /// (edit_distance ASC, frequency_rank ASC).
    pub fn suggest(&self, word: &str, max_suggestions: usize) -> Vec<(String, usize, usize)> {
        let lower = word.to_lowercase();
        let mut candidates: Vec<(String, usize, usize)> = Vec::new(); // (word, distance, rank)

        for (known, &rank) in &self.words {
            // Quick length filter: edit distance ≥ |len difference|
            let len_diff = if known.len() > lower.len() {
                known.len() - lower.len()
            } else {
                lower.len() - known.len()
            };
            if len_diff > MAX_EDIT_DISTANCE {
                continue;
            }

            let dist = damerau_levenshtein(&lower, known);
            if dist <= MAX_EDIT_DISTANCE && dist > 0 {
                candidates.push((known.clone(), dist, rank));
            }
        }

        // Sort: closest edit distance first, then most common word first
        candidates.sort_by(|a, b| a.1.cmp(&b.1).then(a.2.cmp(&b.2)));

        candidates.truncate(max_suggestions);
        candidates
    }

    /// Correct all words in a sentence — context-aware.
    ///
    /// Before correcting any word, checks its neighbors:
    ///   1. If word + next_word is a known phrase → skip correction
    ///   2. If prev_word + word is a known phrase → skip correction
    ///   3. If the proposed correction produces a nonsense bigram with neighbors → skip
    ///
    /// This prevents "curse word" → "course word" because "curse word" is a
    /// recognized phrase and "course word" is not.
    pub fn correct_sentence(&self, text: &str) -> (String, Vec<(String, String)>) {
        let tokens: Vec<&str> = text.split_whitespace().collect();
        let mut corrections: Vec<(String, String)> = Vec::new();
        let mut result_words: Vec<String> = Vec::new();

        for (idx, &token) in tokens.iter().enumerate() {
            let (leading_punct, word, trailing_punct) = split_all_punct(token);

            if word.is_empty() {
                // Pure punctuation token — keep as-is
                result_words.push(token.to_string());
                continue;
            }

            let lower = word.to_lowercase();
            let prev_word = if idx > 0 {
                let (_, pw, _) = split_all_punct(tokens[idx - 1]);
                pw.to_lowercase()
            } else {
                String::new()
            };
            let next_word = if idx + 1 < tokens.len() {
                let (_, nw, _) = split_all_punct(tokens[idx + 1]);
                nw.to_lowercase()
            } else {
                String::new()
            };

            // Check if this word is part of a known phrase — if so, never correct it.
            // "curse word", "swear word", "bad word" etc. should be left alone.
            if is_known_phrase(&lower, &next_word) || is_known_phrase(&prev_word, &lower) {
                result_words.push(token.to_string());
                continue;
            }

            if let Some(corrected) = self.correct(word) {
                // Context validation: reject correction if it creates a nonsense bigram
                // with neighbors, while the original made sense.
                let orig_fwd_ok = is_plausible_bigram(&lower, &next_word);
                let orig_bwd_ok = is_plausible_bigram(&prev_word, &lower);
                let corr_fwd_ok = is_plausible_bigram(&corrected, &next_word);
                let corr_bwd_ok = is_plausible_bigram(&prev_word, &corrected);

                // If original fits context and correction doesn't → skip
                let orig_fits = orig_fwd_ok || orig_bwd_ok;
                let corr_fits = corr_fwd_ok || corr_bwd_ok;
                if orig_fits && !corr_fits {
                    result_words.push(token.to_string());
                    continue;
                }

                let final_word = match_case(word, &corrected);
                corrections.push((word.to_string(), final_word.clone()));
                // Preserve leading + trailing punctuation around corrected word
                result_words.push(format!("{}{}{}", leading_punct, final_word, trailing_punct));
            } else {
                result_words.push(token.to_string());
            }
        }

        (result_words.join(" "), corrections)
    }

    /// Find the closest known word within max_distance.
    pub fn find_closest(&self, word: &str, max_distance: usize) -> Option<String> {
        let mut best: Option<(String, usize, usize)> = None; // (word, distance, rank)

        for (known, &rank) in &self.words {
            // Quick length filter
            let len_diff = if known.len() > word.len() {
                known.len() - word.len()
            } else {
                word.len() - known.len()
            };
            if len_diff > max_distance {
                continue;
            }

            let dist = damerau_levenshtein(word, known);
            if dist > max_distance {
                continue;
            }
            if dist == 0 {
                continue;
            } // exact match (shouldn't happen, but safety)

            let dominated = match &best {
                Some((_, bd, br)) => {
                    // New candidate is better if closer, or same distance but more common
                    dist < *bd || (dist == *bd && rank < *br)
                }
                None => true,
            };

            if dominated {
                best = Some((known.clone(), dist, rank));
            }
        }

        best.map(|(w, _, _)| w)
    }

    /// Get the basis vector for a specific word.
    /// This is the deterministic "Code Language" representation of a token.
    pub fn vector_for_word(&self, word: &str) -> super::SparseVec {
        super::SparseVec::encode(word)
    }

    /// The cached basis table: `(word, SparseVec::encode(word))` for the whole
    /// vocabulary, built once on first call.
    ///
    /// **RSS warning.** For the embedded 10k list this allocates roughly 8 MB of
    /// `SparseVec`s and never releases them (it is cleared only by `add_word`).
    /// It is built lazily precisely so the engine never pays for it: nothing on
    /// the live reply path calls `decode_*`. The first call on the engine's own
    /// `Lexicon` will permanently add that ~8 MB — acceptable for a benchmark,
    /// worth knowing before wiring a decoder into a hot path.
    pub fn basis_table(&self) -> &[(String, super::SparseVec)] {
        self.basis.get_or_init(|| {
            self.ordered
                .iter()
                .map(|s| (s.clone(), super::SparseVec::encode(s)))
                .collect()
        })
    }

    /// Decode a trajectory vector into a sequence of words.
    /// This is the "Generative Head" that replaces string selection.
    ///
    /// Convenience wrapper over [`Lexicon::decode_scored`] using the default
    /// [`DecodeConfig`] with `max_tokens = max_len`.
    pub fn decode_to_sequence(&self, state: &super::SparseVec, max_len: usize) -> Vec<String> {
        let cfg = DecodeConfig {
            max_tokens: max_len,
            ..DecodeConfig::default()
        };
        self.decode_scored(state, &cfg)
            .tokens
            .into_iter()
            .map(|t| t.word)
            .collect()
    }

    /// The ORIGINAL (pre-v9.10.51) peel decoder, preserved verbatim so the
    /// fixed decoder can be A/B measured against it.
    ///
    /// It is kept for evidence, not for use. Two defects make its output noise:
    ///   1. `permute_inv(i)` is applied at EVERY position including `i = 0`, but
    ///      `SparseVec::permute(0)` is NOT the identity permutation (the seed is
    ///      run through `mix_permute_seed`, which maps 0 to a nonzero state and
    ///      then Fisher-Yates shuffles all 16384 dimensions). So even the first
    ///      token is decoded from a fully scrambled state.
    ///   2. The winning word is found in permuted space but inhibited in
    ///      UN-permuted space (`current.contrast(&word_vec)`), so the match is
    ///      never actually removed from the residual and the loop can re-emit.
    ///   3. There is no repetition ban and the only stop rule is the hard-coded
    ///      `> 0.15` cosine floor inside `SparseVec::batch_cosine`.
    pub fn decode_to_sequence_legacy(
        &self,
        state: &super::SparseVec,
        max_len: usize,
    ) -> Vec<String> {
        let mut results = Vec::new();
        let mut current = state.clone();

        let targets: Vec<(&str, super::SparseVec)> = self
            .ordered
            .iter()
            .map(|s| (s.as_str(), super::SparseVec::encode(s)))
            .collect();

        for i in 0..max_len {
            let look_at_pos = current.permute_inv(i as u32);
            if let Some(word) = look_at_pos.batch_cosine(&targets) {
                results.push(word.clone());
                let word_vec = super::SparseVec::encode(&word);
                current = current.contrast(&word_vec);
            } else {
                break;
            }
        }
        results
    }

    /// Peel words out of a superposed state, reporting the resonance of each
    /// emitted token and why decoding stopped.
    ///
    /// Algorithm, per step `i`:
    ///   1. **Probe.** `probe = pos_unbind(residual, i)` — the inverse of the
    ///      positional role permutation. By convention position 0 is the
    ///      IDENTITY (see [`pos_unbind`]); the codebase's `permute(0)` is a real
    ///      shuffle, so calling it at position 0 would scramble an unbound state.
    ///   2. **Search.** Cosine of `probe` against every lexicon basis vector.
    ///      Already-emitted words are hard-banned (`ban_repeats`) or multiplied
    ///      by `repetition_penalty ^ times_emitted`.
    ///   3. **Stop rule.** If the best score is below `min_cosine`, stop. Also
    ///      stops when the residual is empty, the vocabulary is exhausted, or
    ///      `max_tokens` is reached.
    ///   4. **Inhibit.** Remove the winner's support from the residual *in the
    ///      residual's own basis*: `residual.contrast(pos_bind(word_vec, i))`.
    ///      This is the step the legacy decoder got wrong — the match lives at
    ///      permuted indices, so the winner must be pushed FORWARD through the
    ///      same permutation before contrasting.
    ///
    /// Termination:
    ///   * Always bounded by `max_tokens`.
    ///   * With `ban_repeats` (the default) also bounded by the vocabulary size,
    ///     since the candidate set shrinks by one every step.
    ///   * A winner with a strictly positive cosine shares at least one index
    ///     with the residual, so `contrast` removes at least one index and the
    ///     residual's nnz strictly decreases. A winner with cosine <= 0 would
    ///     NOT shrink the residual, so a non-positive best score always stops
    ///     decoding regardless of how low `min_cosine` is set — otherwise a
    ///     caller passing `min_cosine: 0.0, ban_repeats: false` could spin for
    ///     `max_tokens` iterations emitting anti-correlated noise.
    pub fn decode_scored(&self, state: &super::SparseVec, cfg: &DecodeConfig) -> DecodeResult {
        let basis = self.basis_table();
        let mut tokens: Vec<DecodedToken> = Vec::new();
        let mut counts: HashMap<&str, u32> = HashMap::new();
        let mut current = state.clone();
        let mut stop = DecodeStop::MaxTokens;

        if basis.is_empty() {
            return DecodeResult {
                tokens,
                stop: DecodeStop::VocabExhausted,
            };
        }

        for i in 0..cfg.max_tokens {
            if current.nnz() == 0 {
                stop = DecodeStop::ResidualEmpty;
                break;
            }

            let probe = pos_unbind(&current, i, cfg.positional);

            let mut best: Option<(&str, &super::SparseVec, f32)> = None;
            for (word, vec) in basis.iter() {
                let seen = counts.get(word.as_str()).copied().unwrap_or(0);
                if seen > 0 && cfg.ban_repeats {
                    continue;
                }
                let mut score = probe.cosine(vec);
                if !score.is_finite() {
                    continue;
                }
                if seen > 0 {
                    score *= cfg.repetition_penalty.powi(seen as i32);
                }
                match best {
                    Some((_, _, b)) if b >= score => {}
                    _ => best = Some((word.as_str(), vec, score)),
                }
            }

            let Some((word, word_vec, score)) = best else {
                stop = DecodeStop::VocabExhausted;
                break;
            };

            // `score <= 0.0` is an unconditional stop: it means no evidence, and
            // it is also the only case where `contrast` below would fail to
            // shrink the residual (see the termination note above).
            if !score.is_finite() || score <= 0.0 || score < cfg.min_cosine {
                stop = DecodeStop::BelowThreshold;
                break;
            }

            tokens.push(DecodedToken {
                word: word.to_string(),
                score,
            });
            *counts.entry(word).or_insert(0) += 1;

            // Inhibit the winner in the residual's own basis.
            let inhibit = pos_bind(word_vec, i, cfg.positional);
            current = current.contrast(&inhibit);
        }

        DecodeResult { tokens, stop }
    }
}

/// Bind a vector to sequence position `i` (VSA role binding by permutation).
///
/// Position 0 is defined as the IDENTITY. `SparseVec::permute(seed)` runs the
/// seed through `mix_permute_seed`, which maps 0 to `0x9E3779B9` and then
/// Fisher-Yates shuffles all 16384 dimensions — so `permute(0)` is a genuine
/// shuffle, not a no-op. Treating position 0 as identity is what makes an
/// UNBOUND bag-of-words state (which is what every lattice cell actually is)
/// decodable at step 0, and keeps `pos_bind`/`pos_unbind` a true inverse pair.
#[inline]
pub fn pos_bind(v: &super::SparseVec, i: usize, positional: bool) -> super::SparseVec {
    if !positional || i == 0 {
        v.clone()
    } else {
        v.permute(i as u32)
    }
}

/// Inverse of [`pos_bind`]: project a state back to position `i`.
#[inline]
pub fn pos_unbind(v: &super::SparseVec, i: usize, positional: bool) -> super::SparseVec {
    if !positional || i == 0 {
        v.clone()
    } else {
        v.permute_inv(i as u32)
    }
}

/// Why [`Lexicon::decode_scored`] stopped emitting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeStop {
    /// No input state (empty superposition).
    NoInput,
    /// Best remaining candidate scored below `min_cosine`.
    BelowThreshold,
    /// Hit the `max_tokens` cap.
    MaxTokens,
    /// The residual vector was fully consumed by inhibition.
    ResidualEmpty,
    /// Every vocabulary entry has already been emitted (or the vocab is empty).
    VocabExhausted,
}

/// A single decoded token and the cosine that produced it.
#[derive(Clone, Debug)]
pub struct DecodedToken {
    pub word: String,
    pub score: f32,
}

/// Output of [`Lexicon::decode_scored`].
#[derive(Clone, Debug)]
pub struct DecodeResult {
    pub tokens: Vec<DecodedToken>,
    pub stop: DecodeStop,
}

/// Knobs for [`Lexicon::decode_scored`].
#[derive(Clone, Debug)]
pub struct DecodeConfig {
    /// Hard cap on emitted tokens.
    pub max_tokens: usize,
    /// Stop as soon as the best candidate resonates below this cosine.
    /// Chance-level cosine between two independent encodings is ~0.02-0.05,
    /// so 0.12 is comfortably above noise.
    pub min_cosine: f32,
    /// Apply positional role permutation. Only meaningful when the state was
    /// BUILT with positional binding (see `cognition::compose::encode_positional_sequence`).
    /// Lattice cells are not, so this defaults to `false`.
    pub positional: bool,
    /// Hard-ban words already emitted. When false, `repetition_penalty` applies.
    pub ban_repeats: bool,
    /// Multiplier applied per prior emission when `ban_repeats == false`.
    pub repetition_penalty: f32,
}

impl Default for DecodeConfig {
    fn default() -> Self {
        Self {
            max_tokens: 12,
            min_cosine: 0.12,
            positional: false,
            ban_repeats: true,
            repetition_penalty: 0.25,
        }
    }
}

/// Damerau-Levenshtein edit distance.
/// Handles insertions, deletions, substitutions, AND transpositions.
/// Transpositions are critical for typo correction (e.g., "teh" → "the").
fn damerau_levenshtein(a: &str, b: &str) -> usize {
    let a_chars: Vec<char> = a.chars().collect();
    let b_chars: Vec<char> = b.chars().collect();
    let a_len = a_chars.len();
    let b_len = b_chars.len();

    if a_len == 0 {
        return b_len;
    }
    if b_len == 0 {
        return a_len;
    }

    // Quick check: if length difference exceeds max distance, skip full computation
    let len_diff = a_len.abs_diff(b_len);
    if len_diff > MAX_EDIT_DISTANCE {
        return len_diff;
    }

    let mut matrix = vec![vec![0usize; b_len + 1]; a_len + 1];

    for i in 0..=a_len {
        matrix[i][0] = i;
    }
    for j in 0..=b_len {
        matrix[0][j] = j;
    }

    for i in 1..=a_len {
        for j in 1..=b_len {
            let cost = if a_chars[i - 1] == b_chars[j - 1] {
                0
            } else {
                1
            };

            matrix[i][j] = (matrix[i - 1][j] + 1) // deletion
                .min(matrix[i][j - 1] + 1) // insertion
                .min(matrix[i - 1][j - 1] + cost); // substitution

            // Transposition
            if i > 1
                && j > 1
                && a_chars[i - 1] == b_chars[j - 2]
                && a_chars[i - 2] == b_chars[j - 1]
            {
                matrix[i][j] = matrix[i][j].min(matrix[i - 2][j - 2] + cost);
            }
        }
    }

    matrix[a_len][b_len]
}

/// Known fixed phrases — if a word appears in one of these pairs, never correct it.
/// "curse word" is a phrase → "curse" is protected when followed by "word/words".
/// Covers slang, profanity collocations, and common informal phrases.
fn is_known_phrase(w1: &str, w2: &str) -> bool {
    if w1.is_empty() || w2.is_empty() {
        return false;
    }
    matches!(
        (w1, w2),
        // profanity / slang collocations
        ("curse",  "word")  | ("curse",  "words") |
        ("swear",  "word")  | ("swear",  "words") |
        ("bad",    "word")  | ("bad",    "words") |
        ("cuss",   "word")  | ("cuss",   "words") |
        ("dirty",  "word")  | ("dirty",  "words") |
        ("fuck",   "you")   | ("fuck",   "off")   | ("fuck",   "up") |
        ("shit",   "out")   | ("shit",   "up")    |
        ("ass",    "hole")  | ("ass",    "holes")  |
        ("bitch",  "ass")   | ("bad",    "ass")    |
        ("mother", "fucker")| ("bull",   "shit")   |
        // common informal phrases
        ("gonna",  _)       | ("wanna",  _)        | ("gotta",  _) |
        ("kinda",  _)       | ("sorta",  _)        | ("lotta",  _) |
        ("outta",  _)       | ("tryna",  _)        |
        // tech / KAI phrases
        ("kai",    _)       | (_,        "kai")    |
        ("rshl",   _)       | (_,        "rshl")   |
        // common safe pairs that shouldn't be touched
        ("all",    "right") | ("all",    "good")
    )
}

/// Check if two adjacent words form a plausible bigram in general English usage.
/// This is intentionally permissive — we only want to catch clearly wrong pairs
/// like "course word" (never used) vs "curse word" (common phrase).
fn is_plausible_bigram(w1: &str, w2: &str) -> bool {
    if w1.is_empty() || w2.is_empty() {
        return true;
    } // can't judge with no context

    // Explicitly implausible bigrams — correction target + neighbor that makes no sense
    let implausible = [
        ("course", "word"),
        ("course", "words"),
        ("coarse", "word"),
        ("coarse", "words"),
        ("batch", "ass"),
        ("batch", "word"),
        ("butter", "ass"),
    ];
    for (a, b) in &implausible {
        if w1 == *a && w2 == *b {
            return false;
        }
    }
    true
}

/// Split a token into (leading_punct, word, trailing_punct).
/// E.g. `"YOU"` → (`"`, `YOU`, `"`)
///      `hello,` → (``, `hello`, `,`)
fn split_all_punct(token: &str) -> (&str, &str, &str) {
    // Leading
    let lead_end = token.len()
        - token
            .trim_start_matches(|c: char| c.is_ascii_punctuation())
            .len();
    let after_lead = &token[lead_end..];
    // Trailing (on the trimmed part)
    let trail_start = after_lead
        .trim_end_matches(|c: char| c.is_ascii_punctuation())
        .len();
    (
        &token[..lead_end],
        &after_lead[..trail_start],
        &after_lead[trail_start..],
    )
}

/// Preserve the capitalization pattern of the original word on the corrected word.
fn match_case(original: &str, corrected: &str) -> String {
    let orig_chars: Vec<char> = original.chars().collect();
    if orig_chars.is_empty() {
        return corrected.to_string();
    }

    // All uppercase?
    if orig_chars.iter().all(|c| c.is_uppercase()) {
        return corrected.to_uppercase();
    }

    // Title case (first letter uppercase)?
    if orig_chars[0].is_uppercase() {
        let mut s = String::new();
        for (i, c) in corrected.chars().enumerate() {
            if i == 0 {
                s.extend(c.to_uppercase());
            } else {
                s.push(c);
            }
        }
        return s;
    }

    // Default: lowercase
    corrected.to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_lexicon_loads() {
        let lex = Lexicon::load();
        assert!(
            lex.len() > 9000,
            "Should load ~10000 words, got {}",
            lex.len()
        );
    }

    #[test]
    fn test_known_words() {
        let lex = Lexicon::load();
        assert!(lex.is_known("the"));
        assert!(lex.is_known("world"));
        assert!(lex.is_known("computer"));
        assert!(!lex.is_known("asdfghjkl"));
    }

    #[test]
    fn test_frequency_rank() {
        let lex = Lexicon::load();
        // "the" should be rank 0 (most common)
        assert_eq!(lex.rank("the"), Some(0));
        // "of" should be rank 1
        assert_eq!(lex.rank("of"), Some(1));
    }

    #[test]
    fn test_spelling_correction() {
        let lex = Lexicon::load();
        // "helo" → "help" or "hello" (both distance 1)
        let corrected = lex.correct("helo");
        assert!(corrected.is_some(), "Should correct 'helo'");

        // "wrold" → "world" (transposition)
        let corrected = lex.correct("wrold");
        assert!(corrected.is_some(), "Should correct 'wrold'");

        // "teh" → "the" (transposition)
        let corrected = lex.correct("teh");
        assert_eq!(corrected, Some("the".to_string()));
    }

    #[test]
    fn test_known_word_no_correction() {
        let lex = Lexicon::load();
        // Known words should return None (no correction needed)
        assert_eq!(lex.correct("hello"), None);
        assert_eq!(lex.correct("world"), None);
    }

    #[test]
    fn test_sentence_correction() {
        let lex = Lexicon::load();
        let (corrected, fixes) = lex.correct_sentence("teh wrold is beutiful");
        assert!(!fixes.is_empty(), "Should have corrections");
                assert!(corrected.contains("the"), "should contain corrected word");
    }
}
