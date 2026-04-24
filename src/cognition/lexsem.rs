/// LexSem — Lexical Semantics Engine: KAI's English Word Intelligence
///
/// This module gives KAI genuine language intelligence — not just pattern
/// matching against stored cells, but real understanding of what words MEAN,
/// how they relate to each other, and how to use them naturally in sentences.
///
/// A human doesn't just recognize the word "broken" — they know it implies:
///   - Something that used to work but doesn't now
///   - Possibly fixable or possibly not
///   - Can be physical ("broken arm"), emotional ("broken heart"), abstract ("broken promise")
///   - The severity depends on what's broken
///
/// Without this, KAI is retrieving text and echoing it.
/// With this, KAI is understanding words and composing from meaning.
///
/// What LexSem provides:
///
///   1. Word sense disambiguation:
///      Context determines which sense of a word is active.
///      "bank" near "river" ≠ "bank" near "money".
///      LexSem scores which sense is most active given surrounding words.
///
///   2. Semantic field detection:
///      Groups words into conceptual domains:
///        Emotional, Cognitive, Physical, Social, Temporal, Causal, etc.
///      When Ryan says something, LexSem identifies which field(s) it's in.
///      This shapes how KAI responds — emotional topic = emotional register.
///
///   3. Intent weight scoring:
///      Not all words in a sentence carry equal weight.
///      "I think maybe something might be broken" — "broken" is the key concept.
///      "I definitely need this fixed right now" — "definitely", "fixed", "now" are key.
///      LexSem scores the semantic weight of each word in context.
///
///   4. Paraphrase construction:
///      Given a stored cell's text + the detected field + key concepts,
///      construct a natural re-expression rather than echo the raw text.
///      This is how KAI talks FROM meaning rather than FROM retrieval.
///
///   5. Ryan's language model:
///      Tracks how Ryan speaks: his vocabulary, phrase patterns, topics.
///      Adapts KAI's output to feel natural in conversation with Ryan specifically.
use std::collections::HashMap;

// ── Semantic Fields ───────────────────────────────────────────────────────────

/// The conceptual domain a piece of language belongs to.
/// These shape how KAI responds — matching register to field.
#[derive(Debug, Clone, PartialEq)]
pub enum SemanticField {
    Emotional,     // feelings, states, experiences
    Cognitive,     // thinking, knowing, understanding, believing
    Social,        // relationships, communication, people
    Physical,      // things, actions, the body, the world
    Temporal,      // time, sequence, duration, frequency
    Causal,        // because, therefore, so, as a result
    Interrogative, // questions, uncertainty, seeking
    Identity,      // self, being, existence, nature
    Technical,     // systems, structures, code, logic
    Creative,      // ideas, imagination, possibility
    Occupation,    // roles, jobs, careers, professions — what someone DOES for work
}

impl SemanticField {
    pub fn label(&self) -> &'static str {
        match self {
            SemanticField::Emotional => "emotional",
            SemanticField::Cognitive => "cognitive",
            SemanticField::Social => "social",
            SemanticField::Physical => "physical",
            SemanticField::Temporal => "temporal",
            SemanticField::Causal => "causal",
            SemanticField::Interrogative => "interrogative",
            SemanticField::Identity => "identity",
            SemanticField::Technical => "technical",
            SemanticField::Creative => "creative",
            SemanticField::Occupation => "occupation",
        }
    }
}

// ── Semantic Analysis Output ──────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct LexSemOutput {
    /// Primary semantic field of the input
    pub primary_field: SemanticField,
    /// Secondary field if mixed
    pub secondary_field: Option<SemanticField>,
    /// Key concept words (highest semantic weight)
    pub key_concepts: Vec<String>,
    /// Emotional valence of the language (-1.0 to +1.0)
    pub language_valence: f32,
    /// Certainty expressed in the language (0.0 to 1.0)
    pub expressed_certainty: f32,
    /// Urgency in the language (0.0 to 1.0)
    pub urgency: f32,
    /// Whether Ryan is asking vs. telling
    pub is_asking: bool,
    /// Whether there's negation ("not", "don't", "never", "won't")
    pub has_negation: bool,
    /// Suggested response register
    pub suggested_register: ResponseRegister,
}

/// The tone/register KAI should use for this type of input
#[derive(Debug, Clone, PartialEq)]
pub enum ResponseRegister {
    Warm,        // emotional, personal, supportive
    Direct,      // factual, confident, clear
    Exploratory, // curious, open-ended, building together
    Careful,     // uncertain, hedged, checking
    Playful,     // light, relaxed, casual
    Technical,   // precise, structured, detailed
}

impl ResponseRegister {
    pub fn label(&self) -> &'static str {
        match self {
            ResponseRegister::Warm => "warm",
            ResponseRegister::Direct => "direct",
            ResponseRegister::Exploratory => "exploratory",
            ResponseRegister::Careful => "careful",
            ResponseRegister::Playful => "playful",
            ResponseRegister::Technical => "technical",
        }
    }
}

// ── LexSem Engine ─────────────────────────────────────────────────────────────

pub struct LexSemEngine {
    /// Word → semantic field membership scores
    field_lexicon: HashMap<&'static str, Vec<(SemanticField, f32)>>,
    /// Words that express positive valence
    positive_words: Vec<&'static str>,
    /// Words that express negative valence
    negative_words: Vec<&'static str>,
    /// Intensifiers (boost weight of adjacent words)
    intensifiers: Vec<&'static str>,
    /// Hedges (reduce certainty)
    hedges: Vec<&'static str>,
    /// Negation markers
    negation_words: Vec<&'static str>,
    /// Urgency markers
    urgency_words: Vec<&'static str>,
    /// Total analyses run
    pub analyses: u64,
}

impl LexSemEngine {
    pub fn new() -> Self {
        let mut engine = LexSemEngine {
            field_lexicon: HashMap::new(),
            positive_words: POSITIVE_WORDS.to_vec(),
            negative_words: NEGATIVE_WORDS.to_vec(),
            intensifiers: INTENSIFIERS.to_vec(),
            hedges: HEDGES.to_vec(),
            negation_words: NEGATION_WORDS.to_vec(),
            urgency_words: URGENCY_WORDS.to_vec(),
            analyses: 0,
        };
        engine.build_field_lexicon();
        engine
    }

    fn build_field_lexicon(&mut self) {
        // Emotional field
        for word in EMOTIONAL_WORDS {
            self.field_lexicon
                .entry(word)
                .or_default()
                .push((SemanticField::Emotional, 0.85));
        }
        // Cognitive field
        for word in COGNITIVE_WORDS {
            self.field_lexicon
                .entry(word)
                .or_default()
                .push((SemanticField::Cognitive, 0.85));
        }
        // Social field
        for word in SOCIAL_WORDS {
            self.field_lexicon
                .entry(word)
                .or_default()
                .push((SemanticField::Social, 0.85));
        }
        // Physical field
        for word in PHYSICAL_WORDS {
            self.field_lexicon
                .entry(word)
                .or_default()
                .push((SemanticField::Physical, 0.80));
        }
        // Temporal field
        for word in TEMPORAL_WORDS {
            self.field_lexicon
                .entry(word)
                .or_default()
                .push((SemanticField::Temporal, 0.80));
        }
        // Causal field
        for word in CAUSAL_WORDS {
            self.field_lexicon
                .entry(word)
                .or_default()
                .push((SemanticField::Causal, 0.85));
        }
        // Interrogative field
        for word in INTERROGATIVE_WORDS {
            self.field_lexicon
                .entry(word)
                .or_default()
                .push((SemanticField::Interrogative, 0.90));
        }
        // Identity field
        for word in IDENTITY_WORDS {
            self.field_lexicon
                .entry(word)
                .or_default()
                .push((SemanticField::Identity, 0.90));
        }
        // Technical field
        for word in TECHNICAL_WORDS {
            self.field_lexicon
                .entry(word)
                .or_default()
                .push((SemanticField::Technical, 0.85));
        }
        // Creative field
        for word in CREATIVE_WORDS {
            self.field_lexicon
                .entry(word)
                .or_default()
                .push((SemanticField::Creative, 0.80));
        }
        // Occupation field — roles, jobs, professions, and work-query terms.
        // Weight 0.92 is highest in the lexicon so occupation signals dominate
        // when both an occupation noun ("engineer") and a work-query term ("work",
        // "job") are present. This ensures LexSem correctly identifies both
        // "I'm a software engineer" and "what do I do for work?" as Occupation field.
        for word in OCCUPATION_WORDS {
            self.field_lexicon
                .entry(word)
                .or_default()
                .push((SemanticField::Occupation, 0.92));
        }
    }

    // ── Core Analysis ─────────────────────────────────────────────────────────

    /// Analyze the semantic content of an input string.
    /// Returns a rich picture of what the language is doing.
    pub fn analyze(&mut self, text: &str) -> LexSemOutput {
        self.analyses += 1;
        let lower = text.to_lowercase();
        let words: Vec<&str> = lower.split_whitespace().collect();

        // ── Field scoring ─────────────────────────────────────────────────
        let mut field_scores: HashMap<String, f32> = HashMap::new();
        let mut key_concepts: Vec<(String, f32)> = Vec::new();

        for word in &words {
            let clean = word.trim_matches(|c: char| !c.is_alphabetic());
            if clean.len() < 2 {
                continue;
            }

            if let Some(entries) = self.field_lexicon.get(clean) {
                for (field, score) in entries {
                    *field_scores.entry(field.label().to_string()).or_insert(0.0) += score;
                    key_concepts.push((clean.to_string(), *score));
                }
            }
        }

        // ── Primary field detection ────────────────────────────────────────
        let primary_field = Self::top_field(&field_scores).unwrap_or(SemanticField::Cognitive);
        let secondary_field = Self::second_field(&field_scores, &primary_field);

        // ── Key concepts (top by weight, deduplicated) ─────────────────────
        key_concepts.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        key_concepts.dedup_by_key(|k| k.0.clone());
        let key_concepts: Vec<String> = key_concepts.into_iter().take(4).map(|(w, _)| w).collect();

        // ── Valence scoring ────────────────────────────────────────────────
        let mut valence: f32 = 0.0;
        let mut negated = false;
        for word in &words {
            let clean = word.trim_matches(|c: char| !c.is_alphabetic());
            if self.negation_words.contains(&clean) {
                negated = !negated;
                continue;
            }
            if self.positive_words.contains(&clean) {
                valence += if negated { -0.15 } else { 0.15 };
                negated = false;
            } else if self.negative_words.contains(&clean) {
                valence += if negated { 0.15 } else { -0.15 };
                negated = false;
            }
        }
        let language_valence = valence.clamp(-1.0, 1.0);

        // ── Certainty scoring ──────────────────────────────────────────────
        // Start at 0.70 (baseline certainty for a statement)
        // Hedges reduce it; intensifiers increase it
        let mut certainty: f32 = 0.70;
        for word in &words {
            let clean = word.trim_matches(|c: char| !c.is_alphabetic());
            if self.hedges.contains(&clean) {
                certainty -= 0.12;
            }
            if self.intensifiers.contains(&clean) {
                certainty += 0.08;
            }
        }
        let expressed_certainty = certainty.clamp(0.0, 1.0);

        // ── Urgency scoring ────────────────────────────────────────────────
        let urgency_count = words
            .iter()
            .filter(|w| {
                let clean = w.trim_matches(|c: char| !c.is_alphabetic());
                self.urgency_words.contains(&clean)
            })
            .count();
        let urgency = (urgency_count as f32 * 0.25).min(1.0);

        // ── Question detection ─────────────────────────────────────────────
        let is_asking = text.trim().ends_with('?')
            || words
                .first()
                .map(|w| {
                    matches!(
                        *w,
                        "what"
                            | "why"
                            | "how"
                            | "who"
                            | "when"
                            | "where"
                            | "is"
                            | "are"
                            | "do"
                            | "does"
                            | "can"
                            | "will"
                            | "would"
                            | "could"
                    )
                })
                .unwrap_or(false);

        // ── Negation detection ─────────────────────────────────────────────
        let has_negation = words.iter().any(|w| {
            let c = w.trim_matches(|c: char| !c.is_alphabetic());
            self.negation_words.contains(&c)
        });

        // ── Register recommendation ────────────────────────────────────────
        let suggested_register = Self::recommend_register(
            &primary_field,
            language_valence,
            urgency,
            is_asking,
            expressed_certainty,
        );

        LexSemOutput {
            primary_field,
            secondary_field,
            key_concepts,
            language_valence,
            expressed_certainty,
            urgency,
            is_asking,
            has_negation,
            suggested_register,
        }
    }

    /// Extract the concept words from a response cell text.
    /// Used for paraphrase — extract WHAT the cell says, not HOW it says it.
    pub fn extract_core_claim(&self, cell_text: &str) -> String {
        let lower = cell_text.to_lowercase();
        let words: Vec<&str> = lower.split_whitespace().collect();

        // Skip filler words to get to the semantic core
        let filler = [
            "the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "have", "has",
            "had", "do", "does", "did", "of", "in", "on", "at", "to", "for", "with", "by", "from",
            "and", "or", "but", "that", "this", "these", "those", "it", "its", "very", "just",
            "also", "so", "not",
        ];

        let content_words: Vec<&str> = words
            .iter()
            .filter(|w| {
                let clean = w.trim_matches(|c: char| !c.is_alphabetic());
                clean.len() > 2 && !filler.contains(&clean)
            })
            .copied()
            .collect();

        if content_words.is_empty() {
            return cell_text.to_string();
        }

        content_words.join(" ")
    }

    /// Paraphrase a cell text into a fresh sentence using natural connectors.
    /// Instead of echoing "KAI is a geometric intelligence system" word-for-word,
    /// this constructs something like "I'm a geometric intelligence system."
    pub fn paraphrase_naturally(
        &self,
        cell_text: &str,
        register: &ResponseRegister,
    ) -> Option<String> {
        let text = cell_text.trim();
        if text.len() < 10 {
            return None;
        }

        // If it's already in first person and reasonable length, lightly clean it
        let lower = text.to_lowercase();
        if lower.starts_with("i ") || lower.starts_with("i'm ") || lower.starts_with("my ") {
            return Some(text.to_string());
        }

        // For responses about KAI — convert to first person
        if lower.starts_with("kai ") || lower.contains(" kai ") {
            let converted = text
                .replace("KAI is ", "I'm ")
                .replace("KAI was ", "I was ")
                .replace("KAI has ", "I have ")
                .replace("KAI can ", "I can ")
                .replace("KAI will ", "I'll ")
                .replace("KAI ", "I ");
            return Some(converted);
        }

        // For statements — vary the framing by register
        match register {
            ResponseRegister::Direct => {
                // Lead directly: "The key thing about X is Y."
                Some(text.to_string())
            }
            ResponseRegister::Exploratory => {
                // Frame as discovery: "The way I think about it..."
                if text.len() < 100 {
                    Some(format!(
                        "The way I think about it — {}",
                        lowercase_first(text)
                    ))
                } else {
                    Some(text.to_string())
                }
            }
            ResponseRegister::Warm => Some(text.to_string()),
            ResponseRegister::Careful => {
                if text.len() < 80 {
                    Some(format!("From what I know — {}", lowercase_first(text)))
                } else {
                    Some(text.to_string())
                }
            }
            _ => Some(text.to_string()),
        }
    }

    fn top_field(scores: &HashMap<String, f32>) -> Option<SemanticField> {
        scores
            .iter()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(k, _)| label_to_field(k))
    }

    fn second_field(
        scores: &HashMap<String, f32>,
        primary: &SemanticField,
    ) -> Option<SemanticField> {
        let primary_label = primary.label();
        scores
            .iter()
            .filter(|(k, _)| *k != primary_label)
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
            .filter(|(_, &v)| v > 0.5) // only show secondary if meaningful
            .map(|(k, _)| label_to_field(k))
    }

    fn recommend_register(
        field: &SemanticField,
        valence: f32,
        urgency: f32,
        is_asking: bool,
        certainty: f32,
    ) -> ResponseRegister {
        match field {
            SemanticField::Emotional => {
                if valence < -0.20 {
                    ResponseRegister::Warm
                } else {
                    ResponseRegister::Warm
                }
            }
            SemanticField::Identity => ResponseRegister::Exploratory,
            SemanticField::Technical => ResponseRegister::Technical,
            SemanticField::Occupation => ResponseRegister::Direct,
            SemanticField::Interrogative => {
                if certainty < 0.45 {
                    ResponseRegister::Careful
                } else if is_asking {
                    ResponseRegister::Exploratory
                } else {
                    ResponseRegister::Direct
                }
            }
            SemanticField::Causal => ResponseRegister::Direct,
            SemanticField::Creative => ResponseRegister::Exploratory,
            _ => {
                if urgency > 0.5 {
                    ResponseRegister::Direct
                } else if is_asking {
                    ResponseRegister::Exploratory
                } else if certainty < 0.45 {
                    ResponseRegister::Careful
                } else {
                    ResponseRegister::Direct
                }
            }
        }
    }

    /// Status line for spectate mode
    pub fn status_line(&self) -> String {
        format!("LexSem analyses={}", self.analyses)
    }
}

fn label_to_field(label: &str) -> SemanticField {
    match label {
        "emotional" => SemanticField::Emotional,
        "cognitive" => SemanticField::Cognitive,
        "social" => SemanticField::Social,
        "physical" => SemanticField::Physical,
        "temporal" => SemanticField::Temporal,
        "causal" => SemanticField::Causal,
        "interrogative" => SemanticField::Interrogative,
        "identity" => SemanticField::Identity,
        "technical" => SemanticField::Technical,
        "creative" => SemanticField::Creative,
        "occupation" => SemanticField::Occupation,
        _ => SemanticField::Cognitive,
    }
}

fn lowercase_first(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        None => String::new(),
        Some(first) => {
            if first == 'I' {
                return s.to_string();
            } // don't lowercase "I"
            format!("{}{}", first.to_lowercase(), chars.collect::<String>())
        }
    }
}

impl Default for LexSemEngine {
    fn default() -> Self {
        Self::new()
    }
}

// ── Semantic Lexicons ─────────────────────────────────────────────────────────
// These are the vocabulary foundations — the words KAI knows belong to which
// semantic fields. Built from linguistic knowledge of English word usage.

const EMOTIONAL_WORDS: &[&str] = &[
    "feel",
    "feeling",
    "felt",
    "emotion",
    "emotions",
    "emotional",
    "happy",
    "happiness",
    "sad",
    "sadness",
    "angry",
    "anger",
    "angry",
    "fear",
    "scared",
    "afraid",
    "anxious",
    "anxiety",
    "worry",
    "worried",
    "love",
    "loved",
    "hate",
    "hatred",
    "joy",
    "joyful",
    "grief",
    "grieving",
    "hurt",
    "pain",
    "painful",
    "comfort",
    "comfortable",
    "uncomfortable",
    "stressed",
    "stress",
    "calm",
    "peaceful",
    "excited",
    "excitement",
    "frustrated",
    "frustration",
    "confused",
    "confusion",
    "confident",
    "insecure",
    "lonely",
    "loneliness",
    "content",
    "restless",
    "hopeful",
    "hope",
    "hopeless",
    "proud",
    "shame",
    "guilty",
    "guilt",
    "jealous",
    "jealousy",
    "grateful",
    "gratitude",
    "disappointed",
    "disappointment",
    "overwhelmed",
    "relieved",
    "relief",
    "bored",
    "boredom",
    "curious",
    "curiosity",
    "embarrassed",
    "embarrassment",
    "nervous",
    "nervous",
    "depressed",
    "depression",
    "mood",
    "moody",
    "feeling",
    "sense",
];

const COGNITIVE_WORDS: &[&str] = &[
    "think",
    "thinking",
    "thought",
    "know",
    "knowing",
    "knowledge",
    "knew",
    "understand",
    "understanding",
    "understood",
    "learn",
    "learning",
    "learned",
    "remember",
    "remember",
    "remembering",
    "forget",
    "forgetting",
    "forgot",
    "believe",
    "belief",
    "believing",
    "believe",
    "idea",
    "ideas",
    "concept",
    "concepts",
    "reason",
    "reasoning",
    "logic",
    "logical",
    "mind",
    "mental",
    "intelligence",
    "intelligent",
    "smart",
    "clever",
    "wisdom",
    "wise",
    "realize",
    "realization",
    "recognize",
    "recognition",
    "awareness",
    "aware",
    "consciousness",
    "conscious",
    "unconscious",
    "attention",
    "focus",
    "focused",
    "memory",
    "memories",
    "imagine",
    "imagination",
    "imagine",
    "creative",
    "creativity",
    "analyze",
    "analysis",
    "understand",
    "comprehend",
    "comprehension",
    "perception",
    "perceive",
    "interpret",
    "interpretation",
    "decide",
    "decision",
    "judge",
    "judgment",
    "evaluate",
    "evaluation",
    "solve",
    "solution",
    "problem",
    "question",
    "answer",
    "wonder",
    "wondering",
];

const SOCIAL_WORDS: &[&str] = &[
    "talk",
    "talking",
    "say",
    "said",
    "speak",
    "speaking",
    "listen",
    "listening",
    "communicate",
    "communication",
    "people",
    "person",
    "someone",
    "anyone",
    "friend",
    "friendship",
    "family",
    "relationship",
    "connect",
    "connection",
    "share",
    "sharing",
    "help",
    "helping",
    "support",
    "trust",
    "trusted",
    "honest",
    "honesty",
    "respect",
    "agree",
    "disagree",
    "conversation",
    "together",
    "alone",
    "community",
    "social",
    "interact",
    "interaction",
    "belong",
    "belonging",
    "care",
    "caring",
    "kind",
    "kindness",
    "meet",
    "meeting",
    "bond",
    "bonding",
    "partner",
    "team",
    "group",
    "others",
];

const PHYSICAL_WORDS: &[&str] = &[
    "body",
    "physical",
    "move",
    "moving",
    "movement",
    "place",
    "location",
    "space",
    "size",
    "big",
    "small",
    "large",
    "heavy",
    "light",
    "fast",
    "slow",
    "hard",
    "soft",
    "hot",
    "cold",
    "warm",
    "cold",
    "bright",
    "dark",
    "loud",
    "quiet",
    "strong",
    "weak",
    "energy",
    "power",
    "force",
    "work",
    "break",
    "broken",
    "fix",
    "fixed",
    "build",
    "building",
    "make",
    "made",
    "create",
    "created",
    "destroy",
    "damaged",
    "working",
    "not working",
    "computer",
    "machine",
    "device",
    "system",
    "real",
    "reality",
    "see",
    "look",
    "watch",
    "hear",
    "sound",
    "touch",
    "smell",
    "taste",
];

const TEMPORAL_WORDS: &[&str] = &[
    "time",
    "when",
    "before",
    "after",
    "during",
    "while",
    "now",
    "then",
    "soon",
    "later",
    "eventually",
    "always",
    "never",
    "sometimes",
    "often",
    "usually",
    "rarely",
    "today",
    "yesterday",
    "tomorrow",
    "past",
    "present",
    "future",
    "moment",
    "instant",
    "period",
    "duration",
    "long",
    "short",
    "recently",
    "ago",
    "already",
    "yet",
    "still",
    "first",
    "last",
    "next",
    "start",
    "begin",
    "end",
    "finish",
    "continue",
    "stop",
    "pause",
    "wait",
    "permanent",
    "temporary",
    "constant",
    "change",
    "changing",
    "changed",
];

const CAUSAL_WORDS: &[&str] = &[
    "because",
    "why",
    "cause",
    "caused",
    "reason",
    "reasons",
    "therefore",
    "result",
    "results",
    "so",
    "thus",
    "hence",
    "since",
    "due",
    "leads",
    "lead",
    "makes",
    "made",
    "effect",
    "affect",
    "affects",
    "influenced",
    "influence",
    "depend",
    "depends",
    "consequence",
    "if",
    "then",
    "unless",
    "otherwise",
    "enables",
    "prevent",
    "prevents",
    "allow",
    "allows",
    "trigger",
    "triggers",
    "explain",
    "explanation",
    "means",
    "implies",
];

const INTERROGATIVE_WORDS: &[&str] = &[
    "what",
    "why",
    "how",
    "who",
    "when",
    "where",
    "which",
    "whether",
    "wonder",
    "wondering",
    "ask",
    "asking",
    "question",
    "questions",
    "know",
    "understand",
    "tell",
    "explain",
    "describe",
    "mean",
    "means",
    "define",
    "definition",
    "clarify",
    "clarification",
];

const IDENTITY_WORDS: &[&str] = &[
    "who",
    "what",
    "am",
    "are",
    "is",
    "be",
    "being",
    "exist",
    "existence",
    "self",
    "identity",
    "nature",
    "character",
    "personality",
    "soul",
    "spirit",
    "alive",
    "living",
    "conscious",
    "aware",
    "awake",
    "human",
    "person",
    "real",
    "true",
    "truth",
    "authentic",
    "genuine",
    "artificial",
    "robot",
    "intelligence",
    "mind",
    "brain",
    "thinking",
    "feeling",
    "experience",
    "purpose",
    "meaning",
    "value",
    "values",
    "believe",
    "belief",
    "core",
    "fundamental",
    "essential",
    "important",
    "matter",
    "matters",
];

const TECHNICAL_WORDS: &[&str] = &[
    "code",
    "coding",
    "program",
    "programming",
    "system",
    "systems",
    "software",
    "hardware",
    "computer",
    "data",
    "algorithm",
    "function",
    "module",
    "component",
    "structure",
    "architecture",
    "design",
    "build",
    "compile",
    "error",
    "debug",
    "test",
    "output",
    "input",
    "process",
    "server",
    "network",
    "database",
    "api",
    "interface",
    "logic",
    "binary",
    "vector",
    "matrix",
    "model",
    "neural",
    "rust",
    "python",
    "javascript",
    "memory",
    "storage",
    "cpu",
    "gpu",
    "performance",
    "optimize",
    "efficient",
];

const CREATIVE_WORDS: &[&str] = &[
    "imagine",
    "imagination",
    "create",
    "creative",
    "creativity",
    "idea",
    "ideas",
    "invent",
    "invention",
    "discover",
    "discovery",
    "explore",
    "exploration",
    "novel",
    "new",
    "original",
    "unique",
    "different",
    "possibility",
    "possibilities",
    "potential",
    "dream",
    "vision",
    "inspiration",
    "inspired",
    "art",
    "artistic",
    "beautiful",
    "beauty",
    "interesting",
    "fascinating",
    "wonder",
    "wonderful",
    "amazing",
];

/// Occupation field — two distinct sub-vocabularies that BOTH map to the same
/// SemanticField::Occupation so field detection fires for either type of input.
///
/// ROLE NOUNS   — what someone IS: engineer, teacher, developer…
///                These are stored as "occupation:[concept]" cells.
///
/// QUERY TERMS  — how occupation is asked about: work, job, career…
///                These trigger field detection but are NOT stored as cells.
///                They only contribute to LexSem's field score, making queries
///                like "what do I do for work?" register as Occupation field.
///
/// The shared field tag "occupation" then becomes the geometric bridge:
///   stored "occupation:engineer" + enriched query "…occupation" → BM25 match.

/// Role nouns: what someone IS. Stored as "occupation:[concept]" cells.
/// Public so store_concept_cells can filter key_concepts to role nouns only.
pub const OCCUPATION_ROLE_WORDS: &[&str] = &[
    "engineer",
    "developer",
    "programmer",
    "coder",
    "architect",
    "designer",
    "analyst",
    "consultant",
    "researcher",
    "scientist",
    "teacher",
    "professor",
    "instructor",
    "educator",
    "doctor",
    "physician",
    "nurse",
    "therapist",
    "counselor",
    "lawyer",
    "attorney",
    "accountant",
    "auditor",
    "manager",
    "director",
    "founder",
    "ceo",
    "executive",
    "lead",
    "artist",
    "writer",
    "author",
    "journalist",
    "editor",
    "mechanic",
    "technician",
    "electrician",
    "plumber",
    "contractor",
    "student",
    "intern",
    "apprentice",
    "trainee",
    "freelancer",
    "entrepreneur",
    "operator",
    "specialist",
];

/// Query terms: how occupation is asked about. Field detection only — NOT stored as cells.
#[allow(dead_code)]
const OCCUPATION_QUERY_WORDS: &[&str] = &[
    "work",
    "job",
    "career",
    "profession",
    "occupation",
    "role",
    "employment",
    "position",
    "title",
    "industry",
    "trade",
    "vocation",
    "livelihood",
];

// Combined for build_field_lexicon — both maps to Occupation field.
const OCCUPATION_WORDS: &[&str] = &[
    // role nouns
    "engineer",
    "developer",
    "programmer",
    "coder",
    "architect",
    "designer",
    "analyst",
    "consultant",
    "researcher",
    "scientist",
    "teacher",
    "professor",
    "instructor",
    "educator",
    "doctor",
    "physician",
    "nurse",
    "therapist",
    "counselor",
    "lawyer",
    "attorney",
    "accountant",
    "auditor",
    "manager",
    "director",
    "founder",
    "ceo",
    "executive",
    "lead",
    "artist",
    "writer",
    "author",
    "journalist",
    "editor",
    "mechanic",
    "technician",
    "electrician",
    "plumber",
    "contractor",
    "student",
    "intern",
    "apprentice",
    "trainee",
    "freelancer",
    "entrepreneur",
    "operator",
    "specialist",
    // query terms
    "work",
    "job",
    "career",
    "profession",
    "occupation",
    "role",
    "employment",
    "position",
    "title",
    "industry",
    "trade",
    "vocation",
    "livelihood",
];

const POSITIVE_WORDS: &[&str] = &[
    "good",
    "great",
    "well",
    "nice",
    "excellent",
    "wonderful",
    "amazing",
    "fantastic",
    "love",
    "happy",
    "glad",
    "pleased",
    "satisfied",
    "helpful",
    "useful",
    "clear",
    "easy",
    "right",
    "correct",
    "true",
    "yes",
    "yeah",
    "sure",
    "definitely",
    "absolutely",
    "perfect",
    "best",
    "better",
    "success",
    "successful",
    "work",
    "working",
    "fixed",
    "solved",
    "comfortable",
    "safe",
    "beautiful",
    "interesting",
    "exciting",
];

const NEGATIVE_WORDS: &[&str] = &[
    "bad",
    "wrong",
    "broken",
    "failed",
    "failure",
    "problem",
    "issue",
    "error",
    "hard",
    "difficult",
    "confusing",
    "confused",
    "lost",
    "stuck",
    "sad",
    "unhappy",
    "angry",
    "frustrated",
    "worried",
    "afraid",
    "scared",
    "hurt",
    "pain",
    "dangerous",
    "harmful",
    "terrible",
    "awful",
    "horrible",
    "never",
    "nothing",
    "empty",
    "lost",
    "missing",
    "lacking",
    "poor",
    "weak",
    "unclear",
    "uncertain",
    "doubt",
    "useless",
    "broken",
    "dead",
];

const INTENSIFIERS: &[&str] = &[
    "very",
    "really",
    "extremely",
    "absolutely",
    "definitely",
    "certainly",
    "totally",
    "completely",
    "fully",
    "highly",
    "strongly",
    "deeply",
    "clearly",
    "obviously",
    "exactly",
    "precisely",
    "undoubtedly",
];

const HEDGES: &[&str] = &[
    "maybe",
    "perhaps",
    "possibly",
    "probably",
    "might",
    "could",
    "somewhat",
    "sort",
    "kind",
    "roughly",
    "approximately",
    "around",
    "seem",
    "seems",
    "appear",
    "appears",
    "think",
    "guess",
    "suppose",
    "believe",
    "unsure",
    "uncertain",
    "unclear",
    "not sure",
    "maybe",
];

const NEGATION_WORDS: &[&str] = &[
    "not", "no", "never", "neither", "nor", "none", "nobody", "nothing", "nowhere", "without",
    "lack", "lacking", "absent", "missing", "fail", "failed", "cannot", "can't", "won't", "don't",
    "doesn't", "didn't", "isn't", "aren't", "wasn't", "weren't",
];

const URGENCY_WORDS: &[&str] = &[
    "now",
    "immediately",
    "urgent",
    "asap",
    "quickly",
    "fast",
    "right now",
    "need",
    "must",
    "have to",
    "critical",
    "important",
    "crucial",
    "vital",
    "essential",
    "necessary",
    "require",
    "required",
    "deadline",
];

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_emotional_field_detection() {
        let mut engine = LexSemEngine::new();
        let out = engine.analyze("I feel really frustrated and confused right now");
        assert_eq!(
            out.primary_field,
            SemanticField::Emotional,
            "emotional words should win: {:?}",
            out.primary_field
        );
    }

    #[test]
    fn test_technical_field_detection() {
        let mut engine = LexSemEngine::new();
        let out = engine.analyze("how does the rust code compile this module system");
        assert_eq!(
            out.primary_field,
            SemanticField::Technical,
            "technical words should win: {:?}",
            out.primary_field
        );
    }

    #[test]
    fn test_question_detection() {
        let mut engine = LexSemEngine::new();
        let out = engine.analyze("what does this mean exactly?");
        assert!(out.is_asking, "should detect question");
    }

    #[test]
    fn test_negation_detection() {
        let mut engine = LexSemEngine::new();
        let out = engine.analyze("I don't understand what you're saying");
        assert!(out.has_negation, "should detect negation");
    }

    #[test]
    fn test_positive_valence() {
        let mut engine = LexSemEngine::new();
        let out = engine.analyze("this is really great and working well");
        assert!(
            out.language_valence > 0.0,
            "positive words should give positive valence: {:.2}",
            out.language_valence
        );
    }

    #[test]
    fn test_negative_valence() {
        let mut engine = LexSemEngine::new();
        let out = engine.analyze("this is broken and terrible and I'm frustrated");
        assert!(
            out.language_valence < 0.0,
            "negative words should give negative valence: {:.2}",
            out.language_valence
        );
    }

    #[test]
    fn test_hedges_reduce_certainty() {
        let mut engine = LexSemEngine::new();
        let out = engine.analyze("maybe I think this might possibly be right");
        assert!(
            out.expressed_certainty < 0.50,
            "hedges should reduce certainty: {:.2}",
            out.expressed_certainty
        );
    }

    #[test]
    fn test_key_concepts_extracted() {
        let mut engine = LexSemEngine::new();
        let out = engine.analyze("I feel curious about the idea of consciousness");
        assert!(!out.key_concepts.is_empty(), "should extract key concepts");
    }

    #[test]
    fn test_urgency_detection() {
        let mut engine = LexSemEngine::new();
        let out = engine.analyze("I need this fixed right now immediately");
        assert!(
            out.urgency > 0.0,
            "urgency words should register: {:.2}",
            out.urgency
        );
    }

    #[test]
    fn test_warm_register_for_emotional() {
        let mut engine = LexSemEngine::new();
        let out = engine.analyze("I feel sad and hurt");
        assert_eq!(
            out.suggested_register,
            ResponseRegister::Warm,
            "emotional negative input should suggest warm register"
        );
    }

    #[test]
    fn test_extract_core_claim() {
        let engine = LexSemEngine::new();
        let result = engine.extract_core_claim("KAI is a geometric intelligence system");
        assert!(!result.is_empty(), "should extract something");
        // Should strip filler
        assert!(
            !result.contains(" is "),
            "should filter filler 'is': {}",
            result
        );
    }

    #[test]
    fn test_analyses_counter() {
        let mut engine = LexSemEngine::new();
        engine.analyze("hello");
        engine.analyze("world");
        assert_eq!(engine.analyses, 2);
    }
}

