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
const WORD_LIST: &str = include_str!("../../../google-10000-english-usa.txt");

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
            if word.is_empty() { continue; }
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
        if lower.len() < 2 {
            return None;
        }

        self.find_closest(&lower, MAX_EDIT_DISTANCE)
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
            if len_diff > MAX_EDIT_DISTANCE { continue; }

            let dist = damerau_levenshtein(&lower, known);
            if dist <= MAX_EDIT_DISTANCE && dist > 0 {
                candidates.push((known.clone(), dist, rank));
            }
        }

        // Sort: closest edit distance first, then most common word first
        candidates.sort_by(|a, b| {
            a.1.cmp(&b.1).then(a.2.cmp(&b.2))
        });

        candidates.truncate(max_suggestions);
        candidates
    }

    /// Correct all words in a sentence. Returns the corrected sentence
    /// and a list of corrections made.
    pub fn correct_sentence(&self, text: &str) -> (String, Vec<(String, String)>) {
        let mut corrections: Vec<(String, String)> = Vec::new();
        let mut result_words: Vec<String> = Vec::new();

        for token in text.split_whitespace() {
            // Separate punctuation from word
            let (word, trailing_punct) = split_trailing_punct(token);

            if word.is_empty() {
                result_words.push(trailing_punct.to_string());
                continue;
            }

            if let Some(corrected) = self.correct(word) {
                // Preserve original capitalization pattern
                let final_word = match_case(word, &corrected);
                corrections.push((word.to_string(), final_word.clone()));
                result_words.push(format!("{}{}", final_word, trailing_punct));
            } else {
                result_words.push(token.to_string());
            }
        }

        (result_words.join(" "), corrections)
    }

    /// Find the closest known word within max_distance.
    fn find_closest(&self, word: &str, max_distance: usize) -> Option<String> {
        let mut best: Option<(String, usize, usize)> = None; // (word, distance, rank)

        for (known, &rank) in &self.words {
            // Quick length filter
            let len_diff = if known.len() > word.len() {
                known.len() - word.len()
            } else {
                word.len() - known.len()
            };
            if len_diff > max_distance { continue; }

            let dist = damerau_levenshtein(word, known);
            if dist > max_distance { continue; }
            if dist == 0 { continue; } // exact match (shouldn't happen, but safety)

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
}

/// Damerau-Levenshtein edit distance.
/// Handles insertions, deletions, substitutions, AND transpositions.
/// Transpositions are critical for typo correction (e.g., "teh" → "the").
fn damerau_levenshtein(a: &str, b: &str) -> usize {
    let a_chars: Vec<char> = a.chars().collect();
    let b_chars: Vec<char> = b.chars().collect();
    let a_len = a_chars.len();
    let b_len = b_chars.len();

    if a_len == 0 { return b_len; }
    if b_len == 0 { return a_len; }

    // Quick check: if length difference exceeds max distance, skip full computation
    let len_diff = if a_len > b_len { a_len - b_len } else { b_len - a_len };
    if len_diff > MAX_EDIT_DISTANCE { return len_diff; }

    let mut matrix = vec![vec![0usize; b_len + 1]; a_len + 1];

    for i in 0..=a_len { matrix[i][0] = i; }
    for j in 0..=b_len { matrix[0][j] = j; }

    for i in 1..=a_len {
        for j in 1..=b_len {
            let cost = if a_chars[i - 1] == b_chars[j - 1] { 0 } else { 1 };

            matrix[i][j] = (matrix[i - 1][j] + 1)          // deletion
                .min(matrix[i][j - 1] + 1)                  // insertion
                .min(matrix[i - 1][j - 1] + cost);          // substitution

            // Transposition
            if i > 1 && j > 1
                && a_chars[i - 1] == b_chars[j - 2]
                && a_chars[i - 2] == b_chars[j - 1]
            {
                matrix[i][j] = matrix[i][j].min(matrix[i - 2][j - 2] + cost);
            }
        }
    }

    matrix[a_len][b_len]
}

/// Split trailing punctuation from a word token.
fn split_trailing_punct(token: &str) -> (&str, &str) {
    let end = token.len();
    let word_end = token.trim_end_matches(|c: char| c.is_ascii_punctuation()).len();
    if word_end == 0 {
        return ("", token);
    }
    (&token[..word_end], &token[word_end..end])
}

/// Preserve the capitalization pattern of the original word on the corrected word.
fn match_case(original: &str, corrected: &str) -> String {
    let orig_chars: Vec<char> = original.chars().collect();
    if orig_chars.is_empty() { return corrected.to_string(); }

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
        assert!(lex.len() > 9000, "Should load ~10000 words, got {}", lex.len());
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
        assert!(corrected.contains("the"), "Should correct 'teh' to 'the': {}", corrected);
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
