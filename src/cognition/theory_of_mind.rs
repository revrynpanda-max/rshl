/// Theory of Mind — KAI's model of what Ryan knows, believes, and wants
///
/// Theory of Mind (ToM) is the ability to understand that OTHER people have
/// their own mental states — beliefs, desires, knowledge, intentions —
/// that are separate from your own. It's what lets you think:
///   "Ryan doesn't know that yet, so I should explain it"
///   "Ryan seems frustrated — something is off"
///   "Ryan keeps asking about this — it must matter to him"
///   "Ryan is an expert in some things and a beginner in others"
///
/// Without ToM a mind is fundamentally egocentric — it only knows
/// what IT knows and assumes others know the same things. A child
/// under age 4 has no ToM. Most animals don't have it at all.
///
/// Without ToM for KAI:
///   KAI responds the same way regardless of who he's talking to.
///   He doesn't track whether Ryan already knows something.
///   He can't tell if Ryan is confused, frustrated, or deeply engaged.
///   Every response is calibrated for "average person" not for Ryan.
///
/// With ToM for KAI:
///   KAI builds a running model of Ryan's knowledge state:
///     - What topics Ryan has demonstrated knowledge of
///     - What topics Ryan asked about (suggesting he doesn't know them)
///     - Ryan's emotional state patterns across the conversation
///     - Ryan's communication style and expertise signals
///     - What KAI has already explained (no need to repeat)
///
///   This model updates every interaction and shapes responses:
///     "Ryan already knows about RSHL — don't explain it from scratch"
///     "Ryan asked a beginner question about calculus — simplify"
///     "Ryan seems engaged — go deeper"
///
/// Architecture:
///   TheoryOfMind holds a UserModel that tracks:
///     - Knowledge map: topics × estimated familiarity (0=unknown, 1=expert)
///     - Emotional history: detected mood signals across turns
///     - Communication style: verbosity, technicality, question frequency
///     - Turn-level engagement score
///     - What KAI has already explained (avoid repetition)
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Constants ─────────────────────────────────────────────────────────────────

/// Max topics to track in knowledge map
const MAX_KNOWLEDGE_TOPICS: usize = 200;

/// Max items in "already explained" set
const MAX_EXPLAINED: usize = 100;

// ── Familiarity Level ─────────────────────────────────────────────────────────

/// How well Ryan appears to know a topic.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Familiarity {
    Unknown,    // Ryan never mentioned this
    Curious,    // Ryan asked about it (doesn't know it well)
    Familiar,   // Ryan referenced it correctly / casually
    Proficient, // Ryan explained or corrected KAI on it
    Expert,     // Ryan consistently demonstrates deep knowledge
}

impl Familiarity {
    pub fn score(&self) -> f32 {
        match self {
            Familiarity::Unknown => 0.0,
            Familiarity::Curious => 0.2,
            Familiarity::Familiar => 0.5,
            Familiarity::Proficient => 0.75,
            Familiarity::Expert => 1.0,
        }
    }
    pub fn label(&self) -> &'static str {
        match self {
            Familiarity::Unknown => "unknown",
            Familiarity::Curious => "curious",
            Familiarity::Familiar => "familiar",
            Familiarity::Proficient => "proficient",
            Familiarity::Expert => "expert",
        }
    }
}

// ── Detected Emotion ─────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DetectedEmotion {
    pub label: String,
    pub intensity: f32,
    pub turn: u64,
}

// ── User Model ────────────────────────────────────────────────────────────────

/// KAI's internal model of Ryan's mental state.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UserModel {
    /// Topic → familiarity score (0–1)
    pub knowledge_map: HashMap<String, f32>,
    /// Recent emotional signals detected in Ryan's messages
    pub emotion_history: Vec<DetectedEmotion>,
    /// Average message length (style indicator — verbose or terse)
    pub avg_msg_length: f32,
    /// Ratio of questions to statements (0=all statements, 1=all questions)
    pub question_ratio: f32,
    /// Technical vocabulary count (number of domain-specific terms used)
    pub tech_vocab_count: u32,
    /// Engagement score (0=disengaged, 1=deeply engaged)
    pub engagement: f32,
    /// Topics KAI has already explained this session (avoid repetition)
    pub already_explained: Vec<String>,
    /// Turn counter
    pub turns: u64,
    /// Total questions Ryan has asked
    pub questions_asked: u64,
    /// Total statements Ryan has made
    pub statements_made: u64,
}

impl UserModel {
    pub fn new() -> Self {
        Self {
            knowledge_map: HashMap::new(),
            emotion_history: Vec::new(),
            avg_msg_length: 0.0,
            question_ratio: 0.0,
            tech_vocab_count: 0,
            engagement: 0.5,
            already_explained: Vec::new(),
            turns: 0,
            questions_asked: 0,
            statements_made: 0,
        }
    }
}

// ── Theory of Mind ────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TheoryOfMind {
    /// KAI's model of the user
    pub user: UserModel,
    /// Whether the user appears to be an expert overall
    pub user_is_expert: bool,
    /// Detected primary communication style
    pub comm_style: CommunicationStyle,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum CommunicationStyle {
    Terse,          // short messages, direct
    Conversational, // moderate length, natural
    Technical,      // uses domain vocabulary
    Exploratory,    // lots of questions, learning mode
}

impl TheoryOfMind {
    pub fn new() -> Self {
        Self {
            user: UserModel::new(),
            user_is_expert: false,
            comm_style: CommunicationStyle::Conversational,
        }
    }

    /// Process a user message and update the internal model.
    ///
    /// This is the main update function — call it on every user input.
    pub fn observe_input(&mut self, text: &str) {
        self.user.turns += 1;
        let lower = text.to_lowercase();
        let word_count = text.split_whitespace().count();

        // ── Message length tracking ──────────────────────────────────────
        let alpha = 0.15_f32;
        self.user.avg_msg_length =
            self.user.avg_msg_length * (1.0 - alpha) + word_count as f32 * alpha;

        // ── Question vs statement ────────────────────────────────────────
        let is_question = text.ends_with('?')
            || lower.starts_with("what")
            || lower.starts_with("how")
            || lower.starts_with("why")
            || lower.starts_with("who")
            || lower.starts_with("when")
            || lower.starts_with("where")
            || lower.starts_with("can you")
            || lower.starts_with("could you");

        if is_question {
            self.user.questions_asked += 1;
        } else {
            self.user.statements_made += 1;
        }

        let total = self.user.questions_asked + self.user.statements_made;
        if total > 0 {
            self.question_ratio_update();
        }

        // ── Knowledge map update ─────────────────────────────────────────
        // Questions about X → Ryan is curious (doesn't know it well)
        // Statements about X → Ryan knows something about X
        let topics = extract_topics(text);
        for topic in &topics {
            let entry = self.user.knowledge_map.entry(topic.clone()).or_insert(0.0);
            if is_question {
                // Asking about it → curious, score ~0.2
                *entry = (*entry * 0.85 + 0.20 * 0.15).min(1.0);
            } else {
                // Statement about it → familiar or better, score rises
                *entry = (*entry * 0.85 + 0.55 * 0.15).min(1.0);
            }
            // Prune if too many
            if self.user.knowledge_map.len() > MAX_KNOWLEDGE_TOPICS {
                // Remove least-known topic
                if let Some(min_key) = self
                    .user
                    .knowledge_map
                    .iter()
                    .min_by(|a, b| a.1.partial_cmp(b.1).unwrap())
                    .map(|(k, _)| k.clone())
                {
                    self.user.knowledge_map.remove(&min_key);
                }
            }
        }

        // ── Technical vocabulary ─────────────────────────────────────────
        let tech_terms = [
            "rshl",
            "phi_g",
            "chi",
            "rho",
            "tensor",
            "vector",
            "sparse",
            "lattice",
            "hyperdimensional",
            "cosine",
            "embedding",
            "entropy",
            "gradient",
            "eigenvalue",
            "manifold",
            "topology",
            "recursive",
            "algorithm",
            "binary",
            "hexadecimal",
            "api",
            "sdk",
            "async",
            "concurrency",
            "throughput",
            "latency",
            "neuron",
            "synapse",
            "cortex",
            "amygdala",
            "hippocampus",
            "dopamine",
            "oscillator",
        ];
        let tech_count = tech_terms.iter().filter(|t| lower.contains(*t)).count();
        self.user.tech_vocab_count += tech_count as u32;

        // ── Emotion detection ────────────────────────────────────────────
        if let Some(emotion) = detect_emotion(&lower) {
            if self.user.emotion_history.len() >= 10 {
                self.user.emotion_history.remove(0);
            }
            self.user.emotion_history.push(DetectedEmotion {
                label: emotion.0.to_string(),
                intensity: emotion.1,
                turn: self.user.turns,
            });
        }

        // ── Engagement update ────────────────────────────────────────────
        // Longer messages + technical vocab + questions → more engaged
        let engagement_signal = (word_count as f32 / 20.0).min(1.0) * 0.4
            + if is_question { 0.3 } else { 0.1 }
            + (tech_count as f32 * 0.1).min(0.3);
        self.user.engagement = self.user.engagement * 0.80 + engagement_signal * 0.20;

        // ── Update expert status and comm style ──────────────────────────
        self.user_is_expert = self.user.tech_vocab_count > 10
            || self
                .user
                .knowledge_map
                .values()
                .filter(|&&v| v > 0.6)
                .count()
                > 5;

        self.comm_style = if self.user.question_ratio > 0.65 {
            CommunicationStyle::Exploratory
        } else if self.user.tech_vocab_count > 8 {
            CommunicationStyle::Technical
        } else if self.user.avg_msg_length < 6.0 {
            CommunicationStyle::Terse
        } else {
            CommunicationStyle::Conversational
        };
    }

    /// Register that KAI just explained a topic — avoid repeating it.
    pub fn mark_explained(&mut self, topic: &str) {
        if !self.user.already_explained.iter().any(|e| e == topic) {
            if self.user.already_explained.len() >= MAX_EXPLAINED {
                self.user.already_explained.remove(0);
            }
            self.user.already_explained.push(topic.to_string());
        }
    }

    /// Has KAI already explained this topic to Ryan this session?
    pub fn already_explained(&self, topic: &str) -> bool {
        self.user
            .already_explained
            .iter()
            .any(|e| e.to_lowercase().contains(&topic.to_lowercase()))
    }

    /// How familiar is Ryan with a given topic? (0=unknown, 1=expert)
    pub fn familiarity(&self, topic: &str) -> f32 {
        let lower = topic.to_lowercase();
        self.user
            .knowledge_map
            .iter()
            .filter(|(k, _)| k.contains(&lower) || lower.contains(k.as_str()))
            .map(|(_, v)| v)
            .cloned()
            .fold(0.0_f32, f32::max)
    }

    /// Should KAI explain the fundamentals, or skip to the advanced part?
    pub fn needs_basics(&self, topic: &str) -> bool {
        self.familiarity(topic) < 0.35 && !self.user_is_expert
    }

    /// Generate a brief ToM summary for KAI's response calibration.
    pub fn context_hint(&self) -> String {
        let style = match self.comm_style {
            CommunicationStyle::Terse => "brief",
            CommunicationStyle::Technical => "technical",
            CommunicationStyle::Exploratory => "exploratory",
            CommunicationStyle::Conversational => "conversational",
        };
        let expert = if self.user_is_expert {
            "expert user"
        } else {
            "general user"
        };
        format!(
            "[ToM: {} | style={} | engagement={:.2} | questions={}]",
            expert, style, self.user.engagement, self.user.questions_asked
        )
    }

    /// Last detected emotional state.
    pub fn last_emotion(&self) -> Option<&DetectedEmotion> {
        self.user.emotion_history.last()
    }

    fn question_ratio_update(&mut self) {
        let total = (self.user.questions_asked + self.user.statements_made) as f32;
        let raw = self.user.questions_asked as f32 / total;
        self.user.question_ratio = self.user.question_ratio * 0.80 + raw * 0.20;
    }
}

impl Default for TheoryOfMind {
    fn default() -> Self {
        Self::new()
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Extract meaningful topic keywords from a text.
fn extract_topics(text: &str) -> Vec<String> {
    let stop = [
        "the", "and", "for", "that", "this", "with", "from", "have", "what", "how", "why", "who",
        "when", "where", "can", "you", "tell", "know", "does", "did", "your", "are", "was", "will",
    ];
    text.split(|c: char| !c.is_alphabetic())
        .filter(|w| w.len() >= 5)
        .map(|w| w.to_lowercase())
        .filter(|w| !stop.contains(&w.as_str()))
        .take(5)
        .collect()
}

/// Detect emotion signals in a message. Returns (label, intensity) or None.
fn detect_emotion(lower: &str) -> Option<(&'static str, f32)> {
    if lower.contains("love") || lower.contains("amazing") || lower.contains("excited") {
        return Some(("positive", 0.8));
    }
    if lower.contains("hate") || lower.contains("frustrated") || lower.contains("angry") {
        return Some(("negative", 0.8));
    }
    if lower.contains("confused") || lower.contains("don't understand") || lower.contains("lost") {
        return Some(("confused", 0.7));
    }
    if lower.contains("nice") || lower.contains("good") || lower.contains("great") {
        return Some(("positive", 0.5));
    }
    if lower.contains("interesting") || lower.contains("curious") {
        return Some(("curious", 0.6));
    }
    None
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_question_raises_curiosity_not_familiarity() {
        let mut tom = TheoryOfMind::new();
        tom.observe_input("What is calculus?");
        let fam = tom.familiarity("calculus");
        // Curiosity score ~ 0.2 × 0.15 = 0.03 (low — asking ≠ knowing)
        assert!(
            fam < 0.30,
            "asking about calculus shouldn't imply familiarity: {:.3}",
            fam
        );
    }

    #[test]
    fn test_statement_raises_familiarity() {
        let mut tom = TheoryOfMind::new();
        for _ in 0..5 {
            tom.observe_input("lattice geometry is a hyperdimensional ternary structure");
        }
        let fam = tom.familiarity("lattice");
        assert!(
            fam > 0.20,
            "repeated statements should raise familiarity: {:.3}",
            fam
        );
    }

    #[test]
    fn test_tech_vocab_marks_expert() {
        let mut tom = TheoryOfMind::new();
        for _ in 0..5 {
            tom.observe_input("the sparse vector cosine similarity across the hyperdimensional lattice tensor embedding");
        }
        assert!(
            tom.user_is_expert,
            "heavy tech vocab should mark user as expert"
        );
    }

    #[test]
    fn test_already_explained_tracking() {
        let mut tom = TheoryOfMind::new();
        assert!(!tom.already_explained("recursion"));
        tom.mark_explained("recursion");
        assert!(
            tom.already_explained("recursion"),
            "should track explained topics"
        );
    }

    #[test]
    fn test_comm_style_exploratory_on_many_questions() {
        let mut tom = TheoryOfMind::new();
        for _ in 0..10 {
            tom.observe_input("What does this mean?");
        }
        assert_eq!(
            tom.comm_style,
            CommunicationStyle::Exploratory,
            "many questions → exploratory style"
        );
    }

    #[test]
    fn test_emotion_detection() {
        let mut tom = TheoryOfMind::new();
        tom.observe_input("I am so frustrated with this, it makes me angry");
        assert!(tom.last_emotion().is_some(), "should detect emotion");
        assert_eq!(tom.last_emotion().unwrap().label, "negative");
    }

    #[test]
    fn test_needs_basics_for_unknown_topic() {
        let tom = TheoryOfMind::new();
        assert!(
            tom.needs_basics("quantum entanglement"),
            "unknown topic should trigger basics explanation"
        );
    }
}

// KAI v6.0.0
