//! Figurative Language Engine — KAI's pragmatic interpreter.
//!
//! Humans rarely mean things literally. "I punched the door to the moon"
//! is a hyperbole for "I punched it very hard." "Break a leg" means "good luck."
//! "I haven't slept in a million years" means "I'm very tired."
//!
//! This module detects when a claim defies physical reality, common sense, or
//! logical possibility, then reasons about what the speaker *actually meant*.
//!
//! Pipeline for every incoming claim:
//!   1. LITERAL CHECK — parse agent/action/object/result
//!   2. PHYSICS GATE — does this violate known physical limits?
//!   3. PATTERN MATCH — does it match a known figurative pattern?
//!   4. RESOLVE — what did they actually mean?
//!   5. CLASSIFY — literal / hyperbole / idiom / metaphor / sarcasm / impossible
//!
//! The resolved meaning is what gets stored in the lattice.
//! The original + figurative flag is stored so KAI learns the *pattern*.

use serde::{Deserialize, Serialize};

// ── Classification ────────────────────────────────────────────────────────────

/// How to classify an incoming statement.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum FigurativeClass {
    /// Statement is literally true and physically plausible.
    Literal,
    /// Exaggeration for emphasis. "I've told you a million times."
    Hyperbole,
    /// Fixed phrase with non-literal meaning. "Break a leg."
    Idiom,
    /// One thing described as another. "Life is a journey."
    Metaphor,
    /// Opposite of what is meant, usually with irony. "Oh great, another bug."
    Sarcasm,
    /// Physically or logically impossible but not clearly figurative.
    /// KAI holds this with low confidence until more context arrives.
    Impossible,
}

impl std::fmt::Display for FigurativeClass {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Literal    => write!(f, "literal"),
            Self::Hyperbole  => write!(f, "hyperbole"),
            Self::Idiom      => write!(f, "idiom"),
            Self::Metaphor   => write!(f, "metaphor"),
            Self::Sarcasm    => write!(f, "sarcasm"),
            Self::Impossible => write!(f, "impossible"),
        }
    }
}

/// The result of interpreting a statement.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InterpretResult {
    /// The original statement.
    pub original: String,
    /// How this statement was classified.
    pub class: FigurativeClass,
    /// The resolved pragmatic meaning (what they actually meant).
    /// For Literal, this is the same as original.
    pub resolved_meaning: String,
    /// Confidence that this interpretation is correct (0–1).
    pub confidence: f32,
    /// What physical/logical rule was violated, if any.
    pub violation: Option<String>,
    /// Lattice storage strength for the resolved meaning.
    pub store_strength: f32,
}

// ── Physics & Common Sense Rules ─────────────────────────────────────────────

struct PhysicsRule {
    /// Keywords that trigger this rule check
    triggers: &'static [&'static str],
    /// The violation description if this rule is matched
    violation: &'static str,
    /// Likely figurative interpretation category
    likely_class: FigurativeClass,
    /// How to rephrase as the resolved meaning
    resolved_template: &'static str,
}

/// Core physics and common sense rules.
/// Each rule has trigger keywords and a resolved meaning template.
/// `{original}` in the template is replaced with the original text.
static PHYSICS_RULES: &[PhysicsRule] = &[
    PhysicsRule {
        triggers: &["to the moon", "to the moon and back"],
        violation: "Human-generated force cannot propel an object to the moon (escape velocity: 11.2 km/s, human max punch energy: ~150J)",
        likely_class: FigurativeClass::Hyperbole,
        resolved_template: "with extreme force or over an extremely large distance",
    },
    PhysicsRule {
        triggers: &["million times", "billion times", "thousand times", "a million"],
        violation: "Hyperbolic count — humans cannot literally perform actions millions of times",
        likely_class: FigurativeClass::Hyperbole,
        resolved_template: "many, many times (emphasis on repetition)",
    },
    PhysicsRule {
        triggers: &["didn't sleep for a year", "haven't slept in years", "haven't slept in months", "haven't slept in days"],
        violation: "Human biological limit: fatal sleep deprivation occurs within ~11 days",
        likely_class: FigurativeClass::Hyperbole,
        resolved_template: "is very tired and has not slept enough",
    },
    PhysicsRule {
        triggers: &["could eat a horse", "eat a whole horse", "eat a cow"],
        violation: "Humans cannot consume an entire horse (avg 450kg)",
        likely_class: FigurativeClass::Hyperbole,
        resolved_template: "is extremely hungry",
    },
    PhysicsRule {
        triggers: &["died laughing", "dying of laughter", "literally died"],
        violation: "Laughing does not cause death in the literal sense",
        likely_class: FigurativeClass::Hyperbole,
        resolved_template: "found something extremely funny",
    },
    PhysicsRule {
        triggers: &["move mountains", "moved mountains"],
        violation: "Humans cannot physically move mountains",
        likely_class: FigurativeClass::Metaphor,
        resolved_template: "accomplished something very difficult or seemingly impossible",
    },
    PhysicsRule {
        triggers: &["faster than light", "speed of light", "teleported"],
        violation: "Matter cannot travel at or faster than the speed of light (special relativity)",
        likely_class: FigurativeClass::Hyperbole,
        resolved_template: "moved or reacted extremely quickly",
    },
    PhysicsRule {
        triggers: &["heart exploded", "head exploded", "mind blown", "my brain exploded"],
        violation: "Human organs do not literally explode from emotional states",
        likely_class: FigurativeClass::Hyperbole,
        resolved_template: "was extremely surprised, excited, or overwhelmed",
    },
    PhysicsRule {
        triggers: &["cried a river", "cried an ocean", "cried a lake"],
        violation: "Human tear production cannot fill a river (avg: 6-7mL of tears per day)",
        likely_class: FigurativeClass::Hyperbole,
        resolved_template: "cried a great deal or for a long time",
    },
    PhysicsRule {
        triggers: &["waited forever", "took forever", "been waiting forever"],
        violation: "Nothing has occurred for literally infinite time in human experience",
        likely_class: FigurativeClass::Hyperbole,
        resolved_template: "waited a very long time (subjectively)",
    },
];

// ── Idiom Library ─────────────────────────────────────────────────────────────

struct IdiomEntry {
    phrase: &'static str,
    meaning: &'static str,
}

static IDIOMS: &[IdiomEntry] = &[
    IdiomEntry { phrase: "break a leg",          meaning: "good luck" },
    IdiomEntry { phrase: "kick the bucket",      meaning: "to die" },
    IdiomEntry { phrase: "hit the nail on the head", meaning: "to be exactly right" },
    IdiomEntry { phrase: "under the weather",    meaning: "feeling ill or unwell" },
    IdiomEntry { phrase: "bite the bullet",      meaning: "to endure a painful situation with courage" },
    IdiomEntry { phrase: "let the cat out of the bag", meaning: "to reveal a secret" },
    IdiomEntry { phrase: "the ball is in your court", meaning: "it is your turn to take action" },
    IdiomEntry { phrase: "bite off more than you can chew", meaning: "to attempt more than one can handle" },
    IdiomEntry { phrase: "hit the sack",         meaning: "to go to sleep" },
    IdiomEntry { phrase: "spill the beans",      meaning: "to reveal secret information" },
    IdiomEntry { phrase: "it's raining cats and dogs", meaning: "it is raining very heavily" },
    IdiomEntry { phrase: "cost an arm and a leg", meaning: "to be very expensive" },
    IdiomEntry { phrase: "once in a blue moon",  meaning: "very rarely" },
    IdiomEntry { phrase: "burn bridges",         meaning: "to permanently damage a relationship" },
    IdiomEntry { phrase: "piece of cake",        meaning: "something very easy" },
    IdiomEntry { phrase: "blessing in disguise", meaning: "something good that seemed bad at first" },
    IdiomEntry { phrase: "on the fence",         meaning: "undecided" },
    IdiomEntry { phrase: "see eye to eye",       meaning: "to agree with someone" },
    IdiomEntry { phrase: "no pain no gain",      meaning: "you have to work hard to achieve results" },
    IdiomEntry { phrase: "the last straw",       meaning: "the final problem that makes a situation unbearable" },
    IdiomEntry { phrase: "stealing someone's thunder", meaning: "taking credit for someone else's achievement" },
    IdiomEntry { phrase: "kill two birds with one stone", meaning: "to accomplish two things with one action" },
    IdiomEntry { phrase: "you can't have your cake and eat it too",
                 meaning: "you cannot have two incompatible things at once" },
    IdiomEntry { phrase: "add fuel to the fire", meaning: "to make a bad situation worse" },
    IdiomEntry { phrase: "get out of hand",      meaning: "to become uncontrollable" },
];

// ── Sarcasm Detection ─────────────────────────────────────────────────────────

/// Sarcasm signal phrases — positive words in clearly negative or frustrating contexts.
static SARCASM_POSITIVE_MARKERS: &[&str] = &[
    "oh great", "oh wonderful", "oh fantastic", "oh perfect", "oh brilliant",
    "just what i needed", "just what we needed", "sure thing", "yeah right",
    "oh sure", "totally", "obviously", "clearly", "of course",
    "how lovely", "how wonderful", "how delightful",
];

static SARCASM_NEGATIVE_CONTEXT: &[&str] = &[
    "another bug", "broke again", "not working", "crashed", "failed",
    "messed up", "wrong again", "error", "disaster", "worst",
    "great timing", "just perfect",
];

// ── Main Interpreter ──────────────────────────────────────────────────────────

/// Interpret a statement and return its pragmatic meaning.
///
/// Call this on any incoming Discord/chat message before storing it
/// in the lattice. The `InterpretResult` tells you what to store and at
/// what strength.
pub fn interpret(text: &str) -> InterpretResult {
    let lower = text.to_lowercase();

    // 1. Check idiom library first (exact phrase matches)
    for idiom in IDIOMS {
        if lower.contains(idiom.phrase) {
            return InterpretResult {
                original: text.to_string(),
                class: FigurativeClass::Idiom,
                resolved_meaning: format!("\"{}\" means: {}", idiom.phrase, idiom.meaning),
                confidence: 0.92,
                violation: None,
                store_strength: 1.5,
            };
        }
    }

    // 2. Check physics/common sense rules
    for rule in PHYSICS_RULES {
        for trigger in rule.triggers {
            if lower.contains(trigger) {
                let resolved = rule.resolved_template.to_string();
                let class = rule.likely_class.clone();
                return InterpretResult {
                    original: text.to_string(),
                    class,
                    resolved_meaning: resolved,
                    confidence: 0.85,
                    violation: Some(rule.violation.to_string()),
                    store_strength: 1.2,
                };
            }
        }
    }

    // 3. Check sarcasm signals
    let has_positive_marker = SARCASM_POSITIVE_MARKERS.iter().any(|m| lower.contains(m));
    let has_negative_context = SARCASM_NEGATIVE_CONTEXT.iter().any(|m| lower.contains(m));
    if has_positive_marker && has_negative_context {
        return InterpretResult {
            original: text.to_string(),
            class: FigurativeClass::Sarcasm,
            resolved_meaning: format!("expressing frustration or irony — the opposite of what is literally said"),
            confidence: 0.75,
            violation: None,
            store_strength: 1.0,
        };
    }

    // 4. Metaphor heuristic — "X is/was a Y" where X and Y are different categories
    // Simple check: "life is a X", "work is a X", "this is a X" comparisons
    if (lower.contains(" is a ") || lower.contains(" was a ") || lower.contains(" like a "))
        && !is_probably_literal_comparison(&lower)
    {
        // Light metaphor flag — don't override with high confidence, let context decide
        return InterpretResult {
            original: text.to_string(),
            class: FigurativeClass::Metaphor,
            resolved_meaning: text.to_string(), // preserve original, flag as metaphor
            confidence: 0.55,
            violation: None,
            store_strength: 1.1,
        };
    }

    // 5. Default: literal
    InterpretResult {
        original: text.to_string(),
        class: FigurativeClass::Literal,
        resolved_meaning: text.to_string(),
        confidence: 0.80,
        violation: None,
        store_strength: 1.0,
    }
}

/// Heuristic: is "X is a Y" probably a literal statement vs a metaphor?
/// E.g. "KAI is a Rust system" = literal. "Life is a journey" = metaphor.
fn is_probably_literal_comparison(lower: &str) -> bool {
    // If it contains specific technical or factual language, treat as literal
    let literal_signals = [
        "program", "system", "file", "module", "function", "struct", "class",
        "process", "server", "database", "language", "framework", "library",
        "person", "human", "animal", "plant", "object", "device", "machine",
        "number", "type", "kind", "form", "version", "instance",
    ];
    literal_signals.iter().any(|s| lower.contains(s))
}

/// Determine if a resolved interpretation should be stored in the lattice
/// and at what strength. Returns None if the claim should be discarded.
pub fn should_store(result: &InterpretResult) -> Option<f32> {
    match result.class {
        // Impossible claims with no figurative match — hold at very low strength
        FigurativeClass::Impossible => Some(0.3),
        // Sarcasm — store at low strength, flag as uncertain
        FigurativeClass::Sarcasm => Some(0.5),
        // Metaphors with low confidence — store the original only
        FigurativeClass::Metaphor if result.confidence < 0.60 => Some(0.7),
        // Everything else — use the computed store_strength
        _ => Some(result.store_strength),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_moon_punch_is_hyperbole() {
        let r = interpret("I punched that door so hard it went to the moon");
        assert_eq!(r.class, FigurativeClass::Hyperbole);
        assert!(r.violation.is_some());
        assert!(r.resolved_meaning.contains("extreme force"));
    }

    #[test]
    fn test_idiom_break_a_leg() {
        let r = interpret("Break a leg out there!");
        assert_eq!(r.class, FigurativeClass::Idiom);
        assert!(r.resolved_meaning.contains("good luck"));
    }

    #[test]
    fn test_literal_fact() {
        let r = interpret("KAI is a Rust system running on Windows");
        assert_eq!(r.class, FigurativeClass::Literal);
    }

    #[test]
    fn test_hyperbole_million_times() {
        let r = interpret("I've told you this a million times");
        assert_eq!(r.class, FigurativeClass::Hyperbole);
    }

    #[test]
    fn test_sarcasm_great_another_bug() {
        let r = interpret("Oh great, another bug in the system");
        assert_eq!(r.class, FigurativeClass::Sarcasm);
    }

    #[test]
    fn test_idiom_kick_the_bucket() {
        let r = interpret("The old car finally decided to kick the bucket");
        assert_eq!(r.class, FigurativeClass::Idiom);
        assert!(r.resolved_meaning.contains("die"));
    }
}
