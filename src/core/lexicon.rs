/// Lexicon — KAI's Vocabulary Backbone
///
/// Loads 10,000 common English words from the google-10000-english-usa.txt file.
/// Provides:
///   - Word recognition: O(1) lookup to check if a word is known
///   - Spelling correction: Edit-distance based fuzzy matching
///   - Frequency awareness: Words ranked by commonality (rank 0 = "the", most common)
///   - Dream seeding: Random word selection for dream-state exploration
///
/// The lexicon is KAI's "tongue" — it lets him understand what the user
/// MEANT to say, not just what they typed. A misspelled word gets pulled
/// to the nearest known form by mathematical distance, weighted by how
/// common that word is in English.
///
/// This is pure math: edit distance is the resonance between character
/// sequences, and frequency rank is the gravitational pull of common usage.
use std::collections::HashMap;

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

        Self { words, ordered }
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

    /// Decode a trajectory vector into a sequence of words.
    /// This is the "Generative Head" that replaces string selection.
    ///
    /// It works by "peeling" words out of the superposition one by one:
    /// 1. Project the state back to position i using `permute_inv(i)`.
    /// 2. Find the word whose basis vector resonances most with that position.
    /// 3. Contrast (inhibit) that word's bits from the state.
    /// 4. Repeat for the next position.
    pub fn decode_to_sequence(&self, state: &super::SparseVec, max_len: usize) -> Vec<String> {
        let mut results = Vec::new();
        let mut current = state.clone();

        // High-speed parallel targets (cached word vectors)
        let targets: Vec<(&str, super::SparseVec)> = self
            .ordered
            .iter()
            .map(|s| (s.as_str(), super::SparseVec::encode(s)))
            .collect();

        for i in 0..max_len {
            // Shift the state back to the current position (Word i)
            let look_at_pos = current.permute_inv(i as u32);

            // Find best word match in the lexicon via parallel resonance search
            if let Some(word) = look_at_pos.batch_cosine(&targets) {
                results.push(word.clone());
                // Inhibit the used word's bits to allow the next one to surface
                let word_vec = super::SparseVec::encode(&word);
                current = current.contrast(&word_vec);
            } else {
                break;
            }
        }
        results
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
    let len_diff = if a_len > b_len {
        a_len - b_len
    } else {
        b_len - a_len
    };
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
        assert!(
            corrected.contains("the"),
            "Should correct 'teh' to 'the': {}",
            corrected
        );
    }

    #[test]
    fn test_edit_distance() {
        assert_eq!(damerau_levenshtein("kitten", "sitting"), 3);
        assert_eq!(damerau_levenshtein("the", "teh"), 1); // transposition
        assert_eq!(damerau_levenshtein("abc", "abc"), 0);
        assert_eq!(damerau_levenshtein("", "abc"), 3);
    }

    #[test]
    fn test_case_preservation() {
        assert_eq!(match_case("Hello", "world"), "World");
        assert_eq!(match_case("HELLO", "world"), "WORLD");
        assert_eq!(match_case("hello", "World"), "world");
    }
}

// KAI v6.0.0
