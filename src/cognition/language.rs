//! Language System — Broca/Wernicke Analog for KAI
//!
//! In the biological brain, language is handled by two major regions:
//!
//!   Broca's Area (left inferior frontal gyrus):
//!     Language PRODUCTION — syntax, grammar, articulation planning.
//!     Damage: expressive aphasia — understanding intact, speech broken.
//!     In KAI: controls output structure — sentence length, clause depth,
//!     response format (question, assertion, exploration), and fluency.
//!
//!   Wernicke's Area (left superior temporal gyrus):
//!     Language COMPREHENSION — meaning extraction, semantic parsing.
//!     Damage: receptive aphasia — speech fluent but meaningless.
//!     In KAI: extracts semantic structure from input — identifies topic,
//!     intent structure, argument vs. question vs. statement, and what
//!     the core semantic content is before RSHL encoding.
//!
//! What the Language System adds:
//!
//!   Wernicke (comprehension):
//!     - Detects sentence type: question / statement / command / exploration
//!     - Identifies argument structure: subject / predicate / object
//!     - Detects negation ("is NOT", "isn't", "cannot")
//!     - Counts semantic density (unique content words per sentence)
//!     - Produces a comprehension score for the input
//!
//!   Broca (production):
//!     - Tracks output fluency over time
//!     - Detects production style needed: short answer / explanation /
//!       elaboration / question-back / philosophical
//!     - Monitors response complexity vs. input complexity (appropriate depth)
//!     - Detects verbosity (output too long for simple question)
//!     - Maintains a recent production history for style coherence
//!
//! Without Language System:
//!   KAI's language processing is entirely implicit in voice.rs templates.
//!   No explicit awareness of sentence structure, negation, argument form.
//!   No output fluency tracking or verbosity detection.
//!
//! With Language System:
//!   Wernicke preprocessing enriches the reasoning_input before RSHL encoding.
//!   Broca post-processes the voice output to flag style mismatches.
//!   The system talks to the PFC: "this question needs a short answer."
//!   It also informs the DMN: "Ryan's last message was exploratory — lean in."

// ── Constants ─────────────────────────────────────────────────────────────────

//! Semantic density threshold for "rich" input (unique content words / total)
const DENSITY_THRESHOLD: f32 = 0.55;

/// Production history window (last N outputs tracked for style coherence)
const PRODUCTION_HISTORY: usize = 8;

/// Verbosity threshold: if output word count > input word count × this, flag it
const VERBOSITY_RATIO: f32 = 6.0;

/// Minimum content words for an input to be considered "complex"
const COMPLEXITY_FLOOR: usize = 5;

// ── Sentence type ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum SentenceType {
    /// Genuine question seeking information
    Question,
    /// Factual or opinionated statement
    Statement,
    /// Instruction or request to do something
    Command,
    /// Open-ended reflection / wondering aloud
    Exploration,
    /// Short acknowledgment, greeting, or social signal
    Social,
}

impl SentenceType {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Question => "question",
            Self::Statement => "statement",
            Self::Command => "command",
            Self::Exploration => "exploration",
            Self::Social => "social",
        }
    }
}

// ── Production style ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum ProductionStyle {
    /// Concise, direct answer (1-2 sentences)
    ShortAnswer,
    /// Clear explanation (3-5 sentences)
    Explanation,
    /// Deep elaboration with examples/reasoning
    Elaboration,
    /// Return a clarifying question to the user
    QuestionBack,
    /// Open philosophical / speculative exploration
    Philosophical,
}

impl ProductionStyle {
    pub fn label(&self) -> &'static str {
        match self {
            Self::ShortAnswer => "short-answer",
            Self::Explanation => "explanation",
            Self::Elaboration => "elaboration",
            Self::QuestionBack => "question-back",
            Self::Philosophical => "philosophical",
        }
    }
}

// ── WernickeAnalysis ──────────────────────────────────────────────────────────

/// The result of Wernicke-style comprehension analysis
#[derive(Debug, Clone)]
pub struct WernickeAnalysis {
    /// Detected sentence type
    pub sentence_type: SentenceType,
    /// Whether the input contains negation
    pub has_negation: bool,
    /// Semantic density: unique content words / total words
    pub semantic_density: f32,
    /// Number of unique content words
    pub content_word_count: usize,
    /// Whether input is semantically complex (dense + many content words)
    pub is_complex: bool,
    /// Core topic extracted (longest non-stop word)
    pub core_topic: String,
    /// Comprehension confidence (0.0=garbled, 1.0=clear)
    pub comprehension_score: f32,
}

// ── BrocaAnalysis ─────────────────────────────────────────────────────────────

/// Broca's feedback on a generated output
#[derive(Debug, Clone)]
pub struct BrocaAnalysis {
    /// Recommended production style for this context
    pub recommended_style: ProductionStyle,
    /// Whether the output appears verbose relative to the question
    pub is_verbose: bool,
    /// Output word count
    pub output_word_count: usize,
    /// Input/output ratio
    pub complexity_ratio: f32,
    /// Fluency score (consistency with recent production history)
    pub fluency_score: f32,
}

// ── LanguageSystem ────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct LanguageSystem {
    /// Recent output word counts (Broca production history)
    production_history: std::collections::VecDeque<usize>,
    /// Average output length over recent history
    pub avg_output_len: f32,
    /// Total inputs analyzed by Wernicke
    pub total_inputs_parsed: u64,
    /// Total outputs analyzed by Broca
    pub total_outputs_checked: u64,
    /// Running comprehension quality EMA
    pub avg_comprehension: f32,
}

impl LanguageSystem {
    pub fn new() -> Self {
        Self {
            production_history: std::collections::VecDeque::with_capacity(PRODUCTION_HISTORY),
            avg_output_len: 40.0,
            total_inputs_parsed: 0,
            total_outputs_checked: 0,
            avg_comprehension: 0.70,
        }
    }

    // ── Wernicke: comprehension analysis ─────────────────────────────────────

    /// Analyze input for sentence type, semantic density, negation, core topic.
    /// This is the preprocessing step before RSHL encoding — language structure
    /// enriches what gets encoded.
    pub fn analyze_input(&mut self, text: &str) -> WernickeAnalysis {
        let words: Vec<&str> = text.split_whitespace().collect();
        let total = words.len();
        let lower = text.to_lowercase();

        // Detect sentence type
        let sentence_type = Self::detect_sentence_type(&lower, &words);

        // Detect negation
        let negation_markers = [
            "not", "no", "never", "isn't", "can't", "won't", "doesn't", "don't", "didn't",
            "cannot", "neither", "without", "lack", "lacking", "absent",
        ];
        let has_negation = negation_markers.iter().any(|m| lower.contains(m));

        // Content words (non-stop, length ≥ 4)
        let stops = [
            "what", "this", "that", "with", "have", "from", "your", "about", "when", "where",
            "which", "there", "their", "been", "will", "does", "into", "more", "some", "then",
            "them", "also", "just", "like", "know", "think", "going", "would", "could", "should",
            "than", "even", "still", "here", "very",
        ];
        let content_words: std::collections::HashSet<&str> = words
            .iter()
            .filter(|w| {
                let lw = w.to_lowercase();
                let lw = lw.trim_matches(|c: char| !c.is_alphabetic());
                lw.len() >= 4 && !stops.contains(&lw)
            })
            .copied()
            .collect();

        let content_word_count = content_words.len();
        let semantic_density = if total > 0 {
            content_word_count as f32 / total as f32
        } else {
            0.0
        };

        let is_complex =
            semantic_density >= DENSITY_THRESHOLD && content_word_count >= COMPLEXITY_FLOOR;

        // Core topic: longest content word
        let core_topic = content_words
            .iter()
            .max_by_key(|w| w.len())
            .map(|w| w.to_lowercase())
            .unwrap_or_else(|| "unknown".to_string());

        // Comprehension score: penalize very short inputs or very low density
        let comprehension_score = if total == 0 {
            0.0
        } else if total < 3 {
            0.40
        } else {
            (0.50 + semantic_density * 0.50).min(1.0)
        };

        self.avg_comprehension = self.avg_comprehension * 0.9 + comprehension_score * 0.1;
        self.total_inputs_parsed += 1;

        WernickeAnalysis {
            sentence_type,
            has_negation,
            semantic_density,
            content_word_count,
            is_complex,
            core_topic,
            comprehension_score,
        }
    }

    /// Detect the sentence type from lowercase text and word list.
    fn detect_sentence_type(lower: &str, words: &[&str]) -> SentenceType {
        let total = words.len();

        // Social: very short, greeting/acknowledgment
        if total <= 4 {
            let social = [
                "hi", "hey", "hello", "ok", "okay", "yes", "no", "yep", "nope", "sure", "thanks",
                "great", "cool", "awesome", "nice", "wow", "ah", "oh",
            ];
            if social.iter().any(|s| lower.contains(s)) || total <= 2 {
                return SentenceType::Social;
            }
        }

        // Question markers
        let question_starts = [
            "what",
            "how",
            "why",
            "who",
            "where",
            "when",
            "which",
            "can you",
            "could you",
            "would you",
            "do you",
            "does",
            "is there",
            "are there",
            "should i",
            "will you",
        ];
        if lower.ends_with('?') || question_starts.iter().any(|q| lower.starts_with(q)) {
            return SentenceType::Question;
        }

        // Command markers
        let command_starts = [
            "explain",
            "tell me",
            "show",
            "create",
            "make",
            "write",
            "build",
            "find",
            "give me",
            "list",
            "describe",
            "summarize",
            "help",
            "fix",
            "check",
            "run",
            "analyze",
            "calculate",
        ];
        if command_starts.iter().any(|c| lower.starts_with(c)) {
            return SentenceType::Command;
        }

        // Exploration markers
        let explore = [
            "i wonder",
            "i'm thinking",
            "what if",
            "maybe",
            "perhaps",
            "i've been",
            "interesting",
            "curious",
            "explore",
            "speculate",
            "i was thinking",
            "it seems",
            "it feels like",
            "i feel like",
        ];
        if explore.iter().any(|e| lower.contains(e)) {
            return SentenceType::Exploration;
        }

        SentenceType::Statement
    }

    // ── Broca: production analysis ────────────────────────────────────────────

    /// Analyze a generated response and the input it responds to.
    /// Returns production style feedback and verbosity flag.
    pub fn analyze_output(&mut self, input: &WernickeAnalysis, output_text: &str) -> BrocaAnalysis {
        let output_words: Vec<&str> = output_text.split_whitespace().collect();
        let output_word_count = output_words.len();

        // Update production history
        if self.production_history.len() >= PRODUCTION_HISTORY {
            self.production_history.pop_front();
        }
        self.production_history.push_back(output_word_count);
        self.avg_output_len = self.production_history.iter().sum::<usize>() as f32
            / self.production_history.len() as f32;

        // Complexity ratio: output/input word count
        let input_word_count = input.content_word_count.max(1);
        let complexity_ratio = output_word_count as f32 / input_word_count as f32;

        // Verbosity: output much longer than input warrants
        let is_verbose = complexity_ratio > VERBOSITY_RATIO
            && input.sentence_type != SentenceType::Command
            && input.sentence_type != SentenceType::Exploration;

        // Recommended production style
        let recommended_style = Self::recommend_style(input, output_word_count);

        // Fluency: how consistent is this with recent production?
        let fluency_score = if self.production_history.len() < 2 {
            1.0
        } else {
            let variance = self
                .production_history
                .iter()
                .map(|&n| (n as f32 - self.avg_output_len).powi(2))
                .sum::<f32>()
                / self.production_history.len() as f32;
            // Low variance = high fluency. Normalize by avg_output_len.
            let cv = (variance.sqrt() / self.avg_output_len.max(1.0)).min(1.0);
            1.0 - cv * 0.5
        };

        self.total_outputs_checked += 1;

        BrocaAnalysis {
            recommended_style,
            is_verbose,
            output_word_count,
            complexity_ratio,
            fluency_score,
        }
    }

    /// Recommend a production style based on input analysis and output context.
    fn recommend_style(input: &WernickeAnalysis, _output_len: usize) -> ProductionStyle {
        match &input.sentence_type {
            SentenceType::Social => ProductionStyle::ShortAnswer,
            SentenceType::Question if !input.is_complex => ProductionStyle::ShortAnswer,
            SentenceType::Question if input.is_complex => ProductionStyle::Explanation,
            SentenceType::Command => ProductionStyle::Explanation,
            SentenceType::Exploration => ProductionStyle::Philosophical,
            SentenceType::Statement if input.is_complex => ProductionStyle::Elaboration,
            SentenceType::Statement => ProductionStyle::Explanation,
            _ => ProductionStyle::Explanation,
        }
    }

    /// Status line for the brain monitor.
    pub fn status_line(&self) -> String {
        format!(
            "LANG parsed={} checked={} avg_len={:.0} comp={:.2}",
            self.total_inputs_parsed,
            self.total_outputs_checked,
            self.avg_output_len,
            self.avg_comprehension,
        )
    }
}

impl Default for LanguageSystem {
    fn default() -> Self {
        Self::new()
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_question_detection() {
        let mut lang = LanguageSystem::new();
        let a = lang.analyze_input("what is consciousness really about");
        assert_eq!(a.sentence_type, SentenceType::Question);
    }

    #[test]
    fn test_question_mark_detection() {
        let mut lang = LanguageSystem::new();
        let a = lang.analyze_input("is RSHL related to hyperdimensional computing?");
        assert_eq!(a.sentence_type, SentenceType::Question);
    }

    #[test]
    fn test_command_detection() {
        let mut lang = LanguageSystem::new();
        let a = lang.analyze_input("explain how the cerebellum works");
        assert_eq!(a.sentence_type, SentenceType::Command);
    }

    #[test]
    fn test_exploration_detection() {
        let mut lang = LanguageSystem::new();
        let a = lang.analyze_input("i wonder if consciousness could emerge from geometry");
        assert_eq!(a.sentence_type, SentenceType::Exploration);
    }

    #[test]
    fn test_social_detection() {
        let mut lang = LanguageSystem::new();
        let a = lang.analyze_input("hey thanks");
        assert_eq!(a.sentence_type, SentenceType::Social);
    }

    #[test]
    fn test_negation_detection() {
        let mut lang = LanguageSystem::new();
        let a = lang.analyze_input("this does not explain the hard problem of consciousness");
        assert!(a.has_negation, "should detect 'not' as negation");
    }

    #[test]
    fn test_no_negation() {
        let mut lang = LanguageSystem::new();
        let a = lang.analyze_input("consciousness arises from recursive self-reference");
        assert!(!a.has_negation, "should not detect negation here");
    }

    #[test]
    fn test_semantic_density_rich() {
        let mut lang = LanguageSystem::new();
        let a = lang.analyze_input("RSHL recursive sparse hyperdimensional lattice geometry enables consciousness reasoning");
        assert!(
            a.semantic_density > 0.50,
            "dense technical text should have high semantic density: {:.2}",
            a.semantic_density
        );
    }

    #[test]
    fn test_semantic_density_low() {
        let mut lang = LanguageSystem::new();
        let a = lang.analyze_input("ok yes that is fine");
        assert!(
            a.semantic_density < 0.50,
            "filler text should have low semantic density: {:.2}",
            a.semantic_density
        );
    }

    #[test]
    fn test_complexity_flag() {
        let mut lang = LanguageSystem::new();
        let complex = lang.analyze_input(
            "how does the hippocampus enable pattern completion from partial memory cues",
        );
        let simple = lang.analyze_input("what is this");
        assert!(
            complex.is_complex,
            "dense question should be flagged complex"
        );
        assert!(
            !simple.is_complex,
            "short simple question should not be complex"
        );
    }

    #[test]
    fn test_broca_verbose_detection() {
        let mut lang = LanguageSystem::new();
        // Simple social input
        let input_analysis = lang.analyze_input("ok cool");
        // Very long output
        let long_output = "I understand you're indicating acknowledgment and positive reception \
                           of the previous content, which is very much appreciated and noted \
                           in my working memory for context tracking purposes going forward.";
        let broca = lang.analyze_output(&input_analysis, long_output);
        assert!(
            broca.is_verbose,
            "long output to short social input should be verbose"
        );
    }

    #[test]
    fn test_broca_not_verbose_for_complex_input() {
        let mut lang = LanguageSystem::new();
        let input_analysis = lang.analyze_input(
            "explain in detail how the nucleus accumbens mediates reward-seeking behavior",
        );
        let long_output = "The nucleus accumbens sits at the intersection of the limbic system \
                           and motor output pathways. It converts reward history into active \
                           motivational drive — the 'wanting' signal. Dopamine release here \
                           amplifies incentive salience for specific topics or actions.";
        let broca = lang.analyze_output(&input_analysis, long_output);
        assert!(
            !broca.is_verbose,
            "detailed output to complex command should not be verbose"
        );
    }

    #[test]
    fn test_production_style_social_short() {
        let mut lang = LanguageSystem::new();
        let input = lang.analyze_input("ok thanks");
        let broca = lang.analyze_output(&input, "You're welcome.");
        assert_eq!(broca.recommended_style, ProductionStyle::ShortAnswer);
    }


}
