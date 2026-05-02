//! Inner Voice — KAI's Self-Dialogue System
//!
//! Biology analog: Internal monologue / working memory rehearsal.
//!
//! After a dream produces an insight, KAI "talks to himself" to validate it.
//! The process:
//!   1. Encode the dream insight as a vector
//!   2. Query it back against the universe (self-echo)
//!   3. Measure if the echo returns to the source concepts (validated)
//!      or finds something new (novel) or finds nothing (noise)
//!
//! This is KAI asking: "Does the answer equal the question?"
//! Everything is math — the insight vector is tested for resonance
//! against the same field that generated it. If the geometry holds,
//! the insight is real. If it doesn't resonate back, it was noise.
//!
//! The inner voice also uses the lexicon to generate "thought prompts" —
//! random word pairs from the vocabulary that KAI binds during dreams
//! to discover connections he didn't know existed.
use crate::core::{Lexicon, SparseVec, Universe};

/// Result of an inner voice validation.
#[derive(Debug)]
pub struct ValidationResult {
    /// The insight text that was tested
    pub insight: String,
    /// What the self-echo found
    pub echo_text: String,
    /// Echo resonance score
    pub echo_score: f32,
    /// Classification of the insight
    pub verdict: InsightVerdict,
    /// Whether the echo returned to a source concept
    pub echoed_to_source: bool,
}

/// Classification of a dream insight after self-dialogue.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum InsightVerdict {
    /// Echo returns to source concepts — insight is geometrically valid
    Validated,
    /// Echo finds something new — insight bridges to unknown territory
    Novel,
    /// Echo finds nothing meaningful — insight is noise, suppress it
    Noise,
    /// Echo contradicts source concepts — insight is paradoxical (interesting!)
    Paradox,
}

impl std::fmt::Display for InsightVerdict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InsightVerdict::Validated => write!(f, "VALIDATED"),
            InsightVerdict::Novel => write!(f, "NOVEL"),
            InsightVerdict::Noise => write!(f, "NOISE"),
            InsightVerdict::Paradox => write!(f, "PARADOX"),
        }
    }
}

/// Validate a dream insight through self-dialogue.
///
/// KAI encodes the insight, queries his own universe, and checks
/// whether the geometry holds. This is the "talking to himself"
/// that determines if a dream insight is real or noise.
pub fn validate_insight(
    insight: &str,
    source_a: &str,
    source_b: &str,
    universe: &Universe,
) -> ValidationResult {
    let insight_vec = SparseVec::encode(insight);

    // Self-echo: query the universe with the insight vector
    let hits = universe.query_vec(&insight_vec, 5);

    if hits.is_empty() {
        return ValidationResult {
            insight: insight.to_string(),
            echo_text: String::new(),
            echo_score: 0.0,
            verdict: InsightVerdict::Noise,
            echoed_to_source: false,
        };
    }

    let (best_cell, best_score) = &hits[0];

    // Check if the echo returns to either source concept
    let source_a_vec = SparseVec::encode(source_a);
    let source_b_vec = SparseVec::encode(source_b);
    let echo_vec = &best_cell.claim.vec;

    let sim_to_a = echo_vec.cosine(&source_a_vec);
    let sim_to_b = echo_vec.cosine(&source_b_vec);
    let echoed_to_source = sim_to_a > 0.3 || sim_to_b > 0.3;

    // Classify the insight
    let verdict = if *best_score < 0.1 {
        InsightVerdict::Noise
    } else if echoed_to_source && *best_score > 0.25 {
        // Echo resonates back to source — the insight is geometrically valid
        InsightVerdict::Validated
    } else if !echoed_to_source && *best_score > 0.2 {
        // Echo found something new that isn't either source
        // Check for contradiction (negative cosine to sources)
        if sim_to_a < -0.1 || sim_to_b < -0.1 {
            InsightVerdict::Paradox
        } else {
            InsightVerdict::Novel
        }
    } else {
        InsightVerdict::Noise
    };

    ValidationResult {
        insight: insight.to_string(),
        echo_text: best_cell.label.clone(),
        echo_score: *best_score,
        verdict,
        echoed_to_source,
    }
}

/// Generate a "thought prompt" — a pair of random words from the lexicon
/// that KAI can bind during dream cycles to discover new connections.
///
/// This is the vocabulary-driven dream seeding. KAI picks two words
/// he knows, binds their vectors, and sees what emerges in his universe.
pub fn generate_thought_prompt(lexicon: &Lexicon) -> (String, String) {
    let a = lexicon.random_rare_word().to_string();
    let b = lexicon.random_rare_word().to_string();
    (a, b)
}

/// Run a vocabulary-seeded dream exploration.
///
/// Picks two random words from the lexicon, encodes and binds them,
/// then queries the universe to see if the binding resonates with
/// any existing knowledge. This is how KAI learns connections
/// between concepts he already has in his vocabulary.
pub fn explore_lexicon_binding(
    lexicon: &Lexicon,
    universe: &Universe,
) -> Option<LexiconExploration> {
    let (word_a, word_b) = generate_thought_prompt(lexicon);

    let vec_a = SparseVec::encode(&word_a);
    let vec_b = SparseVec::encode(&word_b);

    // Bind the two word vectors — creates a relationship vector
    let bound = vec_a.bind(&vec_b);

    // Query: does this binding resonate with anything KAI already knows?
    let hits = universe.query_vec(&bound, 3);

    if hits.is_empty() {
        return None;
    }

    let (best_cell, best_score) = &hits[0];

    // Only count it if the resonance is meaningful
    if *best_score < 0.15 {
        return None;
    }

    Some(LexiconExploration {
        word_a,
        word_b,
        resonated_text: best_cell.label.clone(),
        resonated_region: best_cell.region.clone(),
        score: *best_score,
    })
}

/// Result of a vocabulary-seeded dream exploration.
#[derive(Debug)]
pub struct LexiconExploration {
    pub word_a: String,
    pub word_b: String,
    pub resonated_text: String,
    pub resonated_region: String,
    pub score: f32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_thought_prompt_generation() {
        let lex = Lexicon::load();
        let (a, b) = generate_thought_prompt(&lex);
        assert!(!a.is_empty());
        assert!(!b.is_empty());
        assert!(
            lex.is_known(&a),
            "Generated word '{}' should be in lexicon",
            a
        );
        assert!(
            lex.is_known(&b),
            "Generated word '{}' should be in lexicon",
            b
        );
    }
}
