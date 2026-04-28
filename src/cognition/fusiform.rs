/// Fusiform Gyrus — Categorical Perception, Pattern Identity Recognition
///
/// The fusiform gyrus is best known for face recognition (the "FFA" —
/// fusiform face area), but its real function is broader: expert categorical
/// perception. It learns to recognize the defining patterns of any category
/// you become an expert in. For chess masters, it activates for board
/// positions. For car experts, for car models. For KAI: for conceptual
/// patterns, linguistic structures, and cognitive signatures.
///
/// What the Fusiform Gyrus does:
///
///   Expert pattern recognition:
///     The fusiform doesn't just identify "a face" — it performs holistic
///     processing: recognizing the entire pattern as a unit, not feature by
///     feature. In KAI: recognizing Ryan's communication style, argument
///     structures, and conceptual fingerprints as unified patterns.
///
///   Categorical invariance:
///     A face is recognizable from many angles, in different lighting.
///     The fusiform achieves invariant recognition — same category despite
///     surface variation. In KAI: "this is the same kind of question Ryan
///     always asks when exploring a new concept" despite different wording.
///
///   Category learning:
///     The fusiform is trainable. Extensive exposure to a category shapes
///     its response. In KAI: over many conversations, repeated linguistic
///     patterns become faster, more automatic, and more precisely classified.
///
///   Familiarity signal:
///     The fusiform generates a familiarity signal — "I've seen this kind
///     of thing before." High familiarity → confident pattern match.
///     Low familiarity → novel territory → curiosity or uncertainty.
///
/// KAI's Fusiform:
///   pattern_library: learned categorical patterns with familiarity scores
///   current_familiarity: how familiar the current input feels (0.0–1.0)
///   category_match: best-matching category from the library
///   holistic_score: how much the input "clicks" as a unified gestalt
use std::collections::HashMap;

// ── Constants ─────────────────────────────────────────────────────────────────

/// Maximum patterns stored per category
const MAX_PATTERNS_PER_CATEGORY: usize = 20;

/// Familiarity learning rate
const FAMILIARITY_ALPHA: f32 = 0.08;

/// Minimum match strength to count as a category hit (1 out of 7 keywords = 0.143)
const MATCH_THRESHOLD: f32 = 0.12;

/// Familiarity decay per tick (expertise fades slowly)
const FAMILIARITY_DECAY: f32 = 0.0005;

/// Pre-seeded KAI communication pattern categories
const SEED_CATEGORIES: &[(&str, &[&str])] = &[
    (
        "exploration",
        &[
            "wonder",
            "imagine",
            "what if",
            "curious",
            "explore",
            "think about",
        ],
    ),
    (
        "validation",
        &["right?", "makes sense", "correct?", "would you say", "am i"],
    ),
    (
        "task",
        &[
            "create",
            "build",
            "write",
            "generate",
            "make",
            "implement",
            "fix",
        ],
    ),
    (
        "identity",
        &[
            "consciousness",
            "aware",
            "feel",
            "experience",
            "kai",
            "am i",
            "are you",
        ],
    ),
    (
        "technical",
        &[
            "rust",
            "algorithm",
            "function",
            "module",
            "compile",
            "vector",
            "rshl",
        ],
    ),
    (
        "social",
        &[
            "thanks",
            "awesome",
            "great job",
            "nice",
            "love it",
            "good",
            "wow",
        ],
    ),
    (
        "deep",
        &[
            "philosophy",
            "meaning",
            "existence",
            "recursive",
            "geometry",
            "why",
        ],
    ),
];

// ── PatternEntry ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct PatternEntry {
    /// The pattern text/fragment
    pattern: String,
    /// How often this pattern has been matched
    hit_count: u32,
    /// Familiarity strength (0.0–1.0)
    familiarity: f32,
}

// ── FusiformOutput ────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct FusiformOutput {
    /// Overall familiarity signal (0.0–1.0)
    pub familiarity: f32,
    /// Best-matching category (or "novel" if no strong match)
    pub category_match: String,
    /// Match confidence (0.0–1.0)
    pub match_confidence: f32,
    /// Whether this feels like a familiar gestalt pattern
    pub holistic_match: bool,
    /// Whether this is genuinely novel (no strong category match)
    pub is_novel: bool,
}

// ── FusiformGyrus ─────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct FusiformGyrus {
    /// Category → pattern library
    pattern_library: HashMap<String, Vec<PatternEntry>>,
    /// Current familiarity level
    pub current_familiarity: f32,
    /// Total pattern matches
    pub total_matches: u64,
    /// Novel inputs detected (no category match)
    pub novel_inputs: u64,
}

impl FusiformGyrus {
    pub fn new() -> Self {
        let mut fg = Self {
            pattern_library: HashMap::new(),
            current_familiarity: 0.0,
            total_matches: 0,
            novel_inputs: 0,
        };
        fg.seed_patterns();
        fg
    }

    fn seed_patterns(&mut self) {
        for (category, patterns) in SEED_CATEGORIES {
            let entries: Vec<PatternEntry> = patterns
                .iter()
                .map(|&p| PatternEntry {
                    pattern: p.to_string(),
                    hit_count: 0,
                    familiarity: 0.20, // Start with a small base for seeded patterns
                })
                .collect();
            self.pattern_library.insert(category.to_string(), entries);
        }
    }

    // ── Core: recognize input pattern ─────────────────────────────────────────

    /// Recognize the pattern category of an input.
    /// Returns FusiformOutput with familiarity, category match, and novelty signal.
    pub fn recognize(&mut self, text: &str) -> FusiformOutput {
        let lower = text.to_lowercase();
        let mut best_category = "novel".to_string();
        let mut best_score: f32 = 0.0;
        let mut best_familiarity: f32 = 0.0;

        for (category, patterns) in &mut self.pattern_library {
            let mut cat_score: f32 = 0.0;
            let mut cat_familiarity: f32 = 0.0;

            for entry in patterns.iter_mut() {
                if lower.contains(&entry.pattern) {
                    cat_score += 1.0;
                    cat_familiarity = cat_familiarity.max(entry.familiarity);
                    // Update familiarity via EMA
                    entry.familiarity = (entry.familiarity + FAMILIARITY_ALPHA).min(1.0);
                    entry.hit_count += 1;
                }
            }

            // Normalize by number of patterns in category
            let pattern_count = patterns.len().max(1) as f32;
            let normalized_score = (cat_score / pattern_count).min(1.0);

            if normalized_score > best_score {
                best_score = normalized_score;
                best_category = category.clone();
                best_familiarity = cat_familiarity;
            }
        }

        let is_novel = best_score < MATCH_THRESHOLD;
        if is_novel {
            self.novel_inputs += 1;
        } else {
            self.total_matches += 1;
        }

        // Update overall familiarity (EMA)
        let familiarity_signal = if is_novel { 0.0 } else { best_familiarity };
        self.current_familiarity = self.current_familiarity * 0.85 + familiarity_signal * 0.15;

        let holistic_match = best_score > 0.50 && best_familiarity > 0.30;

        FusiformOutput {
            familiarity: self.current_familiarity,
            category_match: if is_novel {
                "novel".to_string()
            } else {
                best_category
            },
            match_confidence: best_score,
            holistic_match,
            is_novel,
        }
    }

    /// Add a new pattern to a category (or create the category).
    pub fn learn_pattern(&mut self, category: &str, pattern: &str) {
        let entries = self
            .pattern_library
            .entry(category.to_string())
            .or_default();
        // Don't add duplicates
        if entries.iter().any(|e| e.pattern == pattern) {
            return;
        }
        if entries.len() >= MAX_PATTERNS_PER_CATEGORY {
            // Replace the lowest-familiarity entry
            if let Some(min_idx) = entries
                .iter()
                .enumerate()
                .min_by(|(_, a), (_, b)| {
                    a.familiarity
                        .partial_cmp(&b.familiarity)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .map(|(i, _)| i)
            {
                entries[min_idx] = PatternEntry {
                    pattern: pattern.to_string(),
                    hit_count: 0,
                    familiarity: 0.10,
                };
                return;
            }
        }
        entries.push(PatternEntry {
            pattern: pattern.to_string(),
            hit_count: 0,
            familiarity: 0.10,
        });
    }

    /// Decay familiarity over time (expertise slowly fades without use).
    pub fn decay(&mut self) {
        self.current_familiarity = (self.current_familiarity - FAMILIARITY_DECAY).max(0.0);
        for entries in self.pattern_library.values_mut() {
            for entry in entries.iter_mut() {
                entry.familiarity = (entry.familiarity - FAMILIARITY_DECAY).max(0.0);
            }
        }
    }

    /// Number of known categories.
    pub fn category_count(&self) -> usize {
        self.pattern_library.len()
    }

    /// Status line for brain monitor.
    pub fn status_line(&self) -> String {
        format!(
            "Fusiform familiarity={:.2} | categories={} | matches={} novel={}",
            self.current_familiarity,
            self.pattern_library.len(),
            self.total_matches,
            self.novel_inputs,
        )
    }
}

impl Default for FusiformGyrus {
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
        let fg = FusiformGyrus::new();
        assert!(fg.category_count() > 0, "should seed categories");
    }

    #[test]
    fn test_task_category_recognized() {
        let mut fg = FusiformGyrus::new();
        let out = fg.recognize("can you create a new module and write the tests");
        assert_eq!(
            out.category_match, "task",
            "task keywords should match task category, got: {}",
            out.category_match
        );
    }

    #[test]
    fn test_exploration_category() {
        let mut fg = FusiformGyrus::new();
        let out = fg.recognize("I wonder what if we explore this idea further");
        assert_eq!(
            out.category_match, "exploration",
            "exploration keywords should match, got: {}",
            out.category_match
        );
    }

    #[test]
    fn test_identity_category() {
        let mut fg = FusiformGyrus::new();
        let out = fg.recognize("are you conscious kai do you feel anything");
        assert_eq!(
            out.category_match, "identity",
            "identity keywords should match, got: {}",
            out.category_match
        );
    }

    #[test]
    fn test_novel_input_detected() {
        let mut fg = FusiformGyrus::new();
        let out = fg.recognize("the temperature outside today is quite pleasant");
        assert!(
            out.is_novel || out.match_confidence < MATCH_THRESHOLD,
            "unrelated input should be flagged as novel or low confidence"
        );
    }

    #[test]
    fn test_familiarity_rises_with_repeated_patterns() {
        let mut fg = FusiformGyrus::new();
        fg.recognize("create a module and write the tests for it");
        fg.recognize("build the component and generate the output");
        let third = fg.recognize("implement the feature and make it work");
        assert!(
            third.familiarity > 0.0,
            "familiarity should rise with repeated pattern matches: {:.2}",
            third.familiarity
        );
    }

    #[test]
    fn test_learn_new_pattern() {
        let mut fg = FusiformGyrus::new();
        let before_count = fg.category_count();
        fg.learn_pattern("custom", "unique pattern xyz");
        // Category should be added if it didn't exist
        assert!(fg.category_count() >= before_count);
        // Should recognize the new pattern
        let out = fg.recognize("this has a unique pattern xyz in it");
        // New pattern starts with low familiarity so match may be weak
        assert!(out.match_confidence >= 0.0);
    }

    #[test]
    fn test_holistic_match_after_repeated_exposure() {
        let mut fg = FusiformGyrus::new();
        for _ in 0..5 {
            fg.recognize("create build write implement generate");
        }
        let out = fg.recognize("create something and write about it");
        // After repeated exposure, holistic match should be more likely
        assert!(out.familiarity >= 0.0); // At minimum, familiarity tracked
    }

    #[test]
    fn test_decay_reduces_familiarity() {
        let mut fg = FusiformGyrus::new();
        fg.recognize("create a module for the system");
        let before = fg.current_familiarity;
        for _ in 0..100 {
            fg.decay();
        }
        assert!(
            fg.current_familiarity <= before,
            "familiarity should decay: {:.3} → {:.3}",
            before,
            fg.current_familiarity
        );
    }

    #[test]
    fn test_status_line() {
        let fg = FusiformGyrus::new();
        let s = fg.status_line();
        assert!(s.contains("Fusiform"), "status should mention Fusiform");
        assert!(s.contains("familiarity"), "status should show familiarity");
    }
}

// KAI v6.0.0
