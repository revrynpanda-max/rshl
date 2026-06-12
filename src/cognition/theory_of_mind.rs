//! Theory of Mind — KAI's model of every person he has met.
//!
//! Originally built to track Ryan alone, ToM is now a multi-person registry.
//! KAI builds a `PersonProfile` for every human (and bot) he encounters across
//! Discord, chats, and direct messages. Each profile holds:
//!   - Remembered facts ("Ryan said he has a laptop", "Jake likes Rust")
//!   - Knowledge map (what topics this person knows about)
//!   - Emotion history (how they tend to express themselves)
//!   - Whether they are a bot or human
//!   - When KAI first and last saw them
//!
//! The single-user API is preserved for backward compatibility with the
//! existing engine tick and response generation paths.
//!
//! Theory of Mind (ToM) is the ability to understand that OTHER people have
//! their own mental states — beliefs, desires, knowledge, intentions —
//! that are separate from your own. It's what lets you think:
//!   "Ryan doesn't know that yet, so I should explain it"
//!   "Ryan seems frustrated — something is off"
//!   "Ryan keeps asking about this — it must matter to him"
//!   "Ryan is an expert in some things and a beginner in others"
//!
//! Without ToM a mind is fundamentally egocentric — it only knows
//! what IT knows and assumes others know the same things. A child
//! under age 4 has no ToM. Most animals don't have it at all.
//!
//! Without ToM for KAI:
//!   KAI responds the same way regardless of who he's talking to.
//!   He doesn't track whether Ryan already knows something.
//!   He can't tell if Ryan is confused, frustrated, or deeply engaged.
//!   Every response is calibrated for "average person" not for Ryan.
//!
//! With ToM for KAI:
//!   KAI builds a running model of Ryan's knowledge state:
//!     - What topics Ryan has demonstrated knowledge of
//!     - What topics Ryan asked about (suggesting he doesn't know them)
//!     - Ryan's emotional state patterns across the conversation
//!     - Ryan's communication style and expertise signals
//!     - What KAI has already explained (no need to repeat)
//!
//!   This model updates every interaction and shapes responses:
//!     "Ryan already knows about RSHL — don't explain it from scratch"
//!     "Ryan asked a beginner question about calculus — simplify"
//!     "Ryan seems engaged — go deeper"
//!
//! Architecture:
//!   TheoryOfMind holds a UserModel that tracks:
//!     - Knowledge map: topics × estimated familiarity (0=unknown, 1=expert)
//!     - Emotional history: detected mood signals across turns
//!     - Communication style: verbosity, technicality, question frequency
//!     - Turn-level engagement score
//!     - What KAI has already explained (no need to repeat)
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};

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

// ── Person Fact ───────────────────────────────────────────────────────────────

/// A persistent remembered fact about a specific person.
/// These are extracted from their messages and stored permanently.
/// Examples:
///   "Ryan said he built KAI from scratch"
///   "Ryan mentioned he uses a laptop with an RTX 4050"
///   "Jake said he prefers Rust over Python"
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PersonFact {
    /// The fact text — what KAI remembers about this person.
    pub text: String,
    /// How confident KAI is this is actually true (0–1).
    /// Rises when the person confirms or repeats it. Falls if contradicted.
    pub confidence: f32,
    /// When this fact was first recorded (Unix timestamp).
    pub timestamp: u64,
    /// Source channel/context (e.g. "discord-channel-123", "direct-message")
    pub source: String,
}

// ── Person Profile ────────────────────────────────────────────────────────────

/// KAI's complete model of one person he has met.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PersonProfile {
    /// Discord user ID or username (the registry key).
    pub user_id: String,
    /// Display name as seen in Discord.
    pub display_name: String,
    /// Is this entity a bot? Detected from Discord's bot flag + behavioral heuristics.
    pub is_bot: bool,
    /// Remembered facts about this person.
    pub facts: Vec<PersonFact>,
    /// What topics this person knows/talks about.
    pub knowledge_map: std::collections::HashMap<String, f32>,
    /// Recent emotional signals detected in their messages.
    pub emotion_history: Vec<DetectedEmotion>,
    /// Total messages KAI has observed from this person.
    pub message_count: u64,
    /// Unix timestamp of first observation.
    pub first_seen: u64,
    /// Unix timestamp of most recent observation.
    pub last_seen: u64,
    /// Detected communication style.
    pub comm_style: CommunicationStyle,
    /// Average message length in words.
    pub avg_msg_length: f32,
}

impl PersonProfile {
    pub fn new(user_id: &str, display_name: &str, is_bot: bool) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        Self {
            user_id: user_id.to_string(),
            display_name: display_name.to_string(),
            is_bot,
            facts: Vec::new(),
            knowledge_map: std::collections::HashMap::new(),
            emotion_history: Vec::new(),
            message_count: 0,
            first_seen: now,
            last_seen: now,
            comm_style: CommunicationStyle::Conversational,
            avg_msg_length: 0.0,
        }
    }

    /// Record a new remembered fact about this person.
    /// Avoids storing near-duplicates (checks if fact text is already known).
    pub fn remember_fact(&mut self, text: &str, confidence: f32, source: &str) {
        let lower = text.to_lowercase();
        let already_known = self.facts.iter().any(|f| {
            let sim = word_overlap(&f.text.to_lowercase(), &lower);
            sim > 0.75
        });
        if already_known {
            // Reinforce existing fact
            if let Some(fact) = self.facts.iter_mut().find(|f| {
                word_overlap(&f.text.to_lowercase(), &lower) > 0.75
            }) {
                fact.confidence = (fact.confidence + 0.05).min(1.0);
            }
            return;
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        self.facts.push(PersonFact {
            text: text.to_string(),
            confidence,
            timestamp: now,
            source: source.to_string(),
        });
        // Keep only the 100 most recent facts per person
        if self.facts.len() > 100 {
            self.facts.remove(0);
        }
    }

    /// Observe a message from this person and update their profile.
    pub fn observe_message(&mut self, text: &str) {
        self.message_count += 1;
        self.last_seen = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let word_count = text.split_whitespace().count() as f32;
        let alpha = 0.15_f32;
        self.avg_msg_length = self.avg_msg_length * (1.0 - alpha) + word_count * alpha;

        // Update comm style
        if self.avg_msg_length < 5.0 {
            self.comm_style = CommunicationStyle::Terse;
        } else if text.contains('?') {
            self.comm_style = CommunicationStyle::Exploratory;
        }
    }

    /// Return a brief summary of what KAI knows about this person.
    pub fn summary(&self) -> String {
        let kind = if self.is_bot { "bot" } else { "human" };
        format!(
            "{} ({}) — {} messages, {} facts known",
            self.display_name, kind, self.message_count, self.facts.len()
        )
    }
}

/// Simple word overlap ratio between two lowercase strings (Jaccard-like).
fn word_overlap(a: &str, b: &str) -> f32 {
    let wa: std::collections::HashSet<&str> = a.split_whitespace().collect();
    let wb: std::collections::HashSet<&str> = b.split_whitespace().collect();
    if wa.is_empty() || wb.is_empty() { return 0.0; }
    let inter = wa.intersection(&wb).count();
    let union = wa.union(&wb).count();
    inter as f32 / union as f32
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

impl Default for UserModel {
    fn default() -> Self {
        Self::new()
    }
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
    /// KAI's model of the primary user (Ryan) — preserved for backward compat.
    pub user: UserModel,
    /// Whether the user appears to be an expert overall
    pub user_is_expert: bool,
    /// Detected primary communication style
    pub comm_style: CommunicationStyle,
    /// Multi-person registry — KAI's memory of everyone he has met.
    /// Keyed by Discord user_id or username.
    #[serde(default)]
    pub registry: std::collections::HashMap<String, PersonProfile>,
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
            registry: std::collections::HashMap::new(),
        }
    }

    // ── Multi-person registry API ─────────────────────────────────────────

    /// Get or create a profile for a person by their user ID.
    /// `is_bot` is used only when creating a new profile — ignored for existing ones.
    pub fn get_or_create_profile(&mut self, user_id: &str, display_name: &str, is_bot: bool) -> &mut PersonProfile {
        self.registry
            .entry(user_id.to_string())
            .or_insert_with(|| PersonProfile::new(user_id, display_name, is_bot))
    }

    /// Observe a message from a person identified by user_id.
    /// Updates their profile and optionally extracts a remembered fact.
    pub fn observe_person_message(
        &mut self,
        user_id: &str,
        display_name: &str,
        text: &str,
        is_bot: bool,
        channel: &str,
    ) {
        let profile = self.get_or_create_profile(user_id, display_name, is_bot);
        profile.observe_message(text);

        // Extract personal facts from first-person statements
        if !is_bot {
            let lower = text.to_lowercase();
            let personal_markers = [
                "i am ", "i'm ", "i have ", "i've ", "i was ", "i built ",
                "i created ", "i own ", "i use ", "i work ", "i live ",
                "my name is ", "i like ", "i love ", "i hate ", "i prefer ",
            ];
            let has_personal = personal_markers.iter().any(|m| lower.contains(m));
            // Only extract if it's a meaningful-length statement
            if has_personal && text.split_whitespace().count() >= 5 {
                let fact_text = format!("{} said: \"{}\"", display_name, &text[..text.len().min(150)]);
                profile.remember_fact(&fact_text, 0.70, channel);
            }
        }
    }

    /// Remember a specific fact about a person.
    pub fn remember_about(
        &mut self,
        user_id: &str,
        display_name: &str,
        fact: &str,
        confidence: f32,
        source: &str,
    ) {
        let profile = self.get_or_create_profile(user_id, display_name, false);
        profile.remember_fact(fact, confidence, source);
    }

    /// Retrieve remembered facts about a person.
    pub fn facts_about(&self, user_id: &str) -> Vec<&PersonFact> {
        self.registry
            .get(user_id)
            .map(|p| p.facts.iter().collect())
            .unwrap_or_default()
    }

    /// Is this Discord user ID known to be a bot?
    pub fn is_known_bot(&self, user_id: &str) -> Option<bool> {
        self.registry.get(user_id).map(|p| p.is_bot)
    }

    /// How many people does KAI have profiles for?
    pub fn known_person_count(&self) -> usize {
        self.registry.len()
    }

    /// Summary of all known people.
    pub fn registry_summary(&self) -> Vec<String> {
        self.registry.values().map(|p| p.summary()).collect()
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

// ── Implicit RLHF Feedback Ledger ────────────────────────────────────────────

/// Implicit feedback signal — inferred from the user's next message
/// without them explicitly saying "good" or "bad".
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum FeedbackSignal {
    /// User continued naturally, agreed, or asked a follow-up. Positive.
    Positive,
    /// User corrected, rejected, or expressed confusion. Negative.
    Negative,
    /// No strong signal detected. Neutral.
    Neutral,
}

/// A record of one of KAI's outputs and its cell sources.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OutputRecord {
    /// The cell labels (from lattice hits) that generated this response.
    pub cell_labels: Vec<String>,
    /// The response text KAI produced.
    pub response_text: String,
    /// When this was produced (turn number).
    pub turn: u64,
    /// Running positive hit count.
    pub positive_hits: u32,
    /// Total feedback evaluations received for this record.
    pub total_evaluations: u32,
}

impl OutputRecord {
    /// Belief trust score: how often this cluster of cells produces good responses.
    pub fn trust_score(&self) -> f32 {
        if self.total_evaluations == 0 {
            return 0.5;
        }
        self.positive_hits as f32 / self.total_evaluations as f32
    }
}

/// Ledger tracking KAI's recent outputs for implicit RLHF.
///
/// Every time KAI speaks, we record which lattice cells contributed.
/// The next user input is analyzed for correction/continuation signals.
/// Based on that signal, those cell clusters are reinforced or penalized
/// in the production lattice via the `/feedback` API endpoint.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FeedbackLedger {
    records: VecDeque<OutputRecord>,
    max_records: usize,
}

impl FeedbackLedger {
    pub fn new() -> Self {
        Self {
            records: VecDeque::with_capacity(20),
            max_records: 20,
        }
    }

    /// Record KAI's latest output. Call immediately after generating a response.
    pub fn record_output(&mut self, cell_labels: Vec<String>, response_text: &str, turn: u64) {
        if self.records.len() >= self.max_records {
            self.records.pop_front();
        }
        self.records.push_back(OutputRecord {
            cell_labels,
            response_text: response_text.to_string(),
            turn,
            positive_hits: 0,
            total_evaluations: 0,
        });
    }

    /// Detect the implicit feedback signal from the user's next message.
    ///
    /// This is how KAI reads between the lines:
    /// - If you correct him → the cells that generated that response get penalized
    /// - If you continue naturally → those cells get gently reinforced
    /// - Over time, KAI forms beliefs: high-trust cell clusters emerge
    pub fn detect_signal(next_input: &str) -> FeedbackSignal {
        let lower = next_input.to_lowercase();

        // Strong negative correction signals
        let negative = [
            "no,", "no that", "nope", "wrong", "incorrect", "that's wrong", "thats wrong",
            "not right", "that's not", "thats not", "you're wrong", "youre wrong",
            "i meant", "i mean", "what i said", "that's not what", "thats not what",
            "i didn't ask", "i didnt ask", "not what i", "you misunderstood",
        ];

        // Positive continuation signals
        let positive = [
            "yes", "yeah", "yep", "exactly", "right", "correct", "that's right",
            "thats right", "makes sense", "got it", "nice", "great", "perfect",
            "good", "awesome", "interesting", "love it", "keep going", "continue",
        ];

        for sig in &negative {
            if lower.contains(sig) {
                return FeedbackSignal::Negative;
            }
        }

        for sig in &positive {
            if lower.starts_with(sig) || lower.contains(&format!(" {} ", sig)) {
                return FeedbackSignal::Positive;
            }
        }

        // A short clarifying question about a topic = positive engagement
        if lower.contains('?') && lower.len() < 80 {
            return FeedbackSignal::Positive;
        }

        FeedbackSignal::Neutral
    }

    /// Apply a detected signal to recent records.
    /// Returns the cell labels that should be reinforced or penalized in the lattice.
    pub fn apply_signal(
        &mut self,
        signal: FeedbackSignal,
        current_turn: u64,
    ) -> Vec<(String, f32)> {
        let mut adjustments: Vec<(String, f32)> = Vec::new();

        // Apply to the most recent output record
        if let Some(record) = self.records.back_mut() {
            // Only apply if this is a recent output (within 2 turns)
            if current_turn.saturating_sub(record.turn) <= 2 {
                record.total_evaluations += 1;

                let delta = match signal {
                    FeedbackSignal::Positive => {
                        record.positive_hits += 1;
                        0.12_f32  // gentle positive reinforcement
                    }
                    FeedbackSignal::Negative => {
                        -0.25_f32 // stronger negative penalty
                    }
                    FeedbackSignal::Neutral => 0.0,
                };

                if delta.abs() > 0.001 {
                    for label in &record.cell_labels {
                        adjustments.push((label.clone(), delta));
                    }
                }
            }
        }

        adjustments
    }

    /// Get cell labels with their current trust scores.
    /// High-trust cells form KAI's "beliefs" about facts and topics.
    pub fn trusted_cells(&self) -> Vec<(&str, f32)> {
        let mut cells: Vec<(&str, f32)> = Vec::new();
        for record in &self.records {
            if record.total_evaluations >= 3 && record.trust_score() > 0.7 {
                for label in &record.cell_labels {
                    cells.push((label.as_str(), record.trust_score()));
                }
            }
        }
        cells
    }
}

impl Default for FeedbackLedger {
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

    }
}
