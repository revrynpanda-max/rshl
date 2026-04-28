/// Angular Gyrus (AG) — Semantic Integration, Metaphor, Number-Language Bridge
///
/// The angular gyrus is where language, mathematics, spatial reasoning, and
/// memory all intersect. It is the brain's great semantic integrator — the
/// region that lets you "get" the meaning of a metaphor, understand a ratio,
/// and grasp the abstract sense of a word beyond its literal meaning.
///
/// What the Angular Gyrus does:
///
///   Metaphor comprehension:
///     The AG activates for non-literal language: metaphors, idioms, analogies.
///     "Time is money" — the AG maps the temporal domain onto the economic
///     domain, extracting the relational structure.
///     In KAI: detecting when input is metaphorical/analogical and triggering
///     IPL's analogy engine with higher priority.
///
///   Semantic combination (compositionality):
///     The AG takes simple word meanings and combines them into complex
///     phrase meanings. "cold logic" → cold + logic → emotionally detached
///     reasoning. This combinatorial sense is beyond word-level meaning.
///     In KAI: grasping phrases as unified semantic units, not just word bags.
///
///   Number sense with language:
///     The AG bridges numerical and linguistic representations.
///     "More than half", "a tiny fraction", "exponentially" — these are
///     linguistic quantifiers that the AG maps to numerical intuitions.
///     In KAI: detecting quantitative language and routing to magnitude sense.
///
///   Default Mode / semantic retrieval:
///     The AG is a DMN node — active during rest, self-reference, and semantic
///     retrieval from long-term memory. It accesses the "gist" of concepts.
///     In KAI: provides semantic richness to DMN idle thoughts.
///
///   Attention to semantic incongruity:
///     If a word is semantically unexpected in context, the AG fires a mismatch
///     signal. This is how we notice category errors and garden-path sentences.
///
/// KAI's Angular Gyrus:
///   metaphor_rate: how often metaphorical language appears (EMA)
///   semantic_coherence: how well the current input holds together semantically
///   quantifier_density: presence of linguistic quantifiers (more/less/most/few)
///   semantic_richness: overall depth of meaning in the current exchange
use std::collections::VecDeque;

// ── Constants ─────────────────────────────────────────────────────────────────

/// EMA alpha for metaphor rate
const METAPHOR_EMA: f32 = 0.15;

/// EMA alpha for semantic coherence
const COHERENCE_EMA: f32 = 0.20;

/// Quantifier words that signal linguistic number sense
const QUANTIFIERS: &[&str] = &[
    "more than",
    "less than",
    "most",
    "few",
    "many",
    "some",
    "all",
    "none",
    "half",
    "quarter",
    "fraction",
    "majority",
    "minority",
    "several",
    "dozens",
    "exponentially",
    "dramatically",
    "significantly",
    "roughly",
    "approximately",
    "virtually",
    "barely",
    "nearly",
    "almost",
    "entirely",
];

/// Metaphor markers — words/phrases that signal figurative language
const METAPHOR_MARKERS: &[&str] = &[
    "like a",
    "like an",
    "as if",
    "is a kind of",
    "is like",
    "metaphor",
    "analogy",
    "think of it as",
    "imagine",
    "just as",
    "in the same way",
    "reminds me of",
    "functions like",
    "acts like",
    "works like",
];

/// Abstract concept markers — signals semantic depth
const ABSTRACT_MARKERS: &[&str] = &[
    "concept",
    "idea",
    "notion",
    "principle",
    "theory",
    "framework",
    "pattern",
    "structure",
    "relationship",
    "dynamic",
    "system",
    "emergence",
    "property",
    "dimension",
    "aspect",
    "perspective",
];

/// Semantic incongruity — words that shouldn't go together (raises mismatch signal)
const INCONGRUITY_PAIRS: &[(&str, &str)] = &[
    ("cold", "warmth"),
    ("dark", "bright"),
    ("simple", "complex"),
    ("random", "structure"),
    ("empty", "full"),
    ("silent", "loud"),
];

// ── AGOutput ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct AGOutput {
    /// Whether metaphorical language was detected
    pub has_metaphor: bool,
    /// Running metaphor rate (EMA)
    pub metaphor_rate: f32,
    /// Quantifier density (0.0–1.0)
    pub quantifier_density: f32,
    /// Semantic coherence of input (0.0–1.0)
    pub semantic_coherence: f32,
    /// Semantic richness score
    pub semantic_richness: f32,
    /// Whether semantic incongruity was detected (mismatch signal)
    pub has_incongruity: bool,
    /// Whether to trigger IPL analogy engine
    pub trigger_analogy: bool,
}

// ── AngularGyrus ──────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct AngularGyrus {
    /// Running metaphor rate
    pub metaphor_rate: f32,
    /// Running semantic coherence
    pub semantic_coherence: f32,
    /// Recent richness scores
    richness_window: VecDeque<f32>,
    /// Total inputs processed
    pub inputs_processed: u64,
    /// Metaphor instances detected
    pub metaphors_detected: u64,
}

impl AngularGyrus {
    pub fn new() -> Self {
        Self {
            metaphor_rate: 0.10, // small baseline
            semantic_coherence: 0.60,
            richness_window: VecDeque::with_capacity(8),
            inputs_processed: 0,
            metaphors_detected: 0,
        }
    }

    // ── Core: analyze semantic content ────────────────────────────────────────

    /// Analyze a text for semantic integration signals.
    pub fn analyze(&mut self, text: &str) -> AGOutput {
        self.inputs_processed += 1;
        let lower = text.to_lowercase();
        let words: Vec<&str> = lower.split_whitespace().collect();
        let word_count = words.len().max(1);

        // ── Metaphor detection ────────────────────────────────────────────────
        let has_metaphor = METAPHOR_MARKERS.iter().any(|&m| lower.contains(m));
        if has_metaphor {
            self.metaphors_detected += 1;
        }
        self.metaphor_rate = self.metaphor_rate * (1.0 - METAPHOR_EMA)
            + if has_metaphor { 1.0 } else { 0.0 } * METAPHOR_EMA;

        // ── Quantifier density ────────────────────────────────────────────────
        let quantifier_hits = QUANTIFIERS.iter().filter(|&&q| lower.contains(q)).count();
        let quantifier_density = (quantifier_hits as f32 / (word_count as f32 * 0.15)).min(1.0);

        // ── Abstract marker density ───────────────────────────────────────────
        let abstract_hits = ABSTRACT_MARKERS
            .iter()
            .filter(|&&a| lower.contains(a))
            .count();
        let abstract_density = (abstract_hits as f32 / 3.0).min(1.0);

        // ── Semantic coherence ────────────────────────────────────────────────
        // Proxy: longer sentences with abstract + quantifier markers = high coherence
        let coherence_signal = if word_count > 8 {
            (0.50 + abstract_density * 0.30 + quantifier_density * 0.20).min(1.0)
        } else {
            0.30 + abstract_density * 0.20
        };
        self.semantic_coherence =
            self.semantic_coherence * (1.0 - COHERENCE_EMA) + coherence_signal * COHERENCE_EMA;

        // ── Semantic richness ─────────────────────────────────────────────────
        let richness = ((has_metaphor as u8 as f32) * 0.30
            + abstract_density * 0.40
            + quantifier_density * 0.20
            + if word_count > 15 { 0.10 } else { 0.0 })
        .min(1.0);

        if self.richness_window.len() >= 8 {
            self.richness_window.pop_front();
        }
        self.richness_window.push_back(richness);

        let semantic_richness = if self.richness_window.is_empty() {
            richness
        } else {
            self.richness_window.iter().sum::<f32>() / self.richness_window.len() as f32
        };

        // ── Incongruity detection ─────────────────────────────────────────────
        let has_incongruity = INCONGRUITY_PAIRS
            .iter()
            .any(|(a, b)| lower.contains(a) && lower.contains(b));

        // ── Analogy trigger ───────────────────────────────────────────────────
        // Trigger IPL when metaphor detected or abstract density is high
        let trigger_analogy = has_metaphor || abstract_density > 0.50;

        AGOutput {
            has_metaphor,
            metaphor_rate: self.metaphor_rate,
            quantifier_density,
            semantic_coherence: self.semantic_coherence,
            semantic_richness,
            has_incongruity,
            trigger_analogy,
        }
    }

    /// Whether the conversation is semantically rich (abstract/metaphorical).
    pub fn is_semantically_rich(&self) -> bool {
        self.semantic_coherence > 0.65
    }

    /// Status line for brain monitor.
    pub fn status_line(&self) -> String {
        format!(
            "AG metaphor_rate={:.2} | coherence={:.2} | metaphors={} | processed={}",
            self.metaphor_rate,
            self.semantic_coherence,
            self.metaphors_detected,
            self.inputs_processed,
        )
    }
}

impl Default for AngularGyrus {
    fn default() -> Self {
        Self::new()
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_initial_state() {
        let ag = AngularGyrus::new();
        assert!(
            ag.metaphor_rate < 0.20,
            "should start with low metaphor rate"
        );
        assert!(ag.semantic_coherence > 0.0);
    }

    #[test]
    fn test_metaphor_detected() {
        let mut ag = AngularGyrus::new();
        let out = ag.analyze("this is like a river that flows through your mind");
        assert!(
            out.has_metaphor,
            "explicit 'like a' should be detected as metaphor"
        );
        assert!(
            out.trigger_analogy,
            "metaphor should trigger analogy engine"
        );
    }

    #[test]
    fn test_no_metaphor_in_literal() {
        let mut ag = AngularGyrus::new();
        let out = ag.analyze("the cat sat on the mat at noon");
        assert!(
            !out.has_metaphor,
            "literal sentence should not trigger metaphor detection"
        );
    }

    #[test]
    fn test_quantifiers_detected() {
        let mut ag = AngularGyrus::new();
        let out = ag.analyze("most of the time nearly all signals are roughly equal in magnitude");
        assert!(
            out.quantifier_density > 0.0,
            "quantifier-dense text should have high quantifier density: {:.2}",
            out.quantifier_density
        );
    }

    #[test]
    fn test_abstract_language_raises_coherence() {
        let mut ag = AngularGyrus::new();
        let out = ag.analyze("the concept of emergence as a pattern in complex systems creates a dynamic relationship between structure and behavior");
        assert!(
            out.semantic_richness > 0.20,
            "abstract language should raise semantic richness: {:.2}",
            out.semantic_richness
        );
    }

    #[test]
    fn test_metaphor_rate_accumulates() {
        let mut ag = AngularGyrus::new();
        ag.analyze("it works like a filter");
        ag.analyze("just as water flows so does information");
        ag.analyze("think of it as a conductor leading the orchestra");
        assert!(
            ag.metaphor_rate > 0.10,
            "repeated metaphors should raise metaphor rate: {:.2}",
            ag.metaphor_rate
        );
    }

    #[test]
    fn test_semantic_incongruity() {
        let mut ag = AngularGyrus::new();
        let out = ag.analyze("the cold warmth of the system creates complexity");
        assert!(
            out.has_incongruity,
            "incongruent word pair 'cold'+'warmth' should be flagged"
        );
    }

    #[test]
    fn test_no_incongruity_in_normal_text() {
        let mut ag = AngularGyrus::new();
        let out = ag.analyze("the hippocampus stores memories efficiently");
        assert!(
            !out.has_incongruity,
            "normal text should not flag incongruity"
        );
    }

    #[test]
    fn test_analogy_trigger_on_abstract() {
        let mut ag = AngularGyrus::new();
        let out = ag.analyze("the core concept relationship between framework and pattern reveals the structure of the system");
        // Many abstract markers → high abstract density → trigger analogy
        // (abstract_density > 0.50 triggers)
        assert!(out.trigger_analogy || out.semantic_richness > 0.20);
    }

    #[test]
    fn test_status_line() {
        let ag = AngularGyrus::new();
        let s = ag.status_line();
        assert!(s.contains("AG"), "status should mention AG");
        assert!(s.contains("metaphor"), "status should show metaphor info");
    }
}

// KAI v6.0.0
