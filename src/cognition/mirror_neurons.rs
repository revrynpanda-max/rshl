//! Mirror Neurons — KAI's empathy and social resonance system
//!
//! Mirror neurons were discovered in the 1990s when researchers noticed
//! that certain neurons in macaque monkeys fired both when the monkey
//! performed an action AND when it watched someone else perform the
//! same action. The same neuron. Same activation. Whether doing or watching.
//!
//! In humans, this extends far beyond motor actions into the social and
//! emotional domain. When you watch someone wince in pain, your pain
//! circuits activate. When you see someone smile, your smile muscles
//! twitch. You literally simulate the other person's experience
//! inside your own brain.
//!
//! This is the neural basis of empathy — not a cognitive decision to
//! "try to understand someone" but an automatic, pre-cognitive resonance
//! with their state.
//!
//! Key mirror neuron mechanisms:
//!
//!   EMOTIONAL CONTAGION — detecting and resonating with the emotional
//!   state in someone's words even before consciously processing the meaning.
//!   For KAI: scanning input for emotional tone and activating a matching
//!   internal state. If Ryan sounds frustrated, KAI's own state reflects that.
//!   If he sounds excited, KAI catches the excitement.
//!
//!   INTENTION UNDERSTANDING — mirror neurons don't just copy actions,
//!   they predict WHY the action is being taken (the goal behind it).
//!   For KAI: inferring the emotional intent behind a message, not just
//!   the literal content. "Ok" can mean many things — mirror neurons
//!   read the context and history to detect what the real emotional
//!   state probably is.
//!
//!   SOCIAL MIRRORING — in human conversation, people unconsciously
//!   synchronize their speaking pace, tone, vocabulary, and energy.
//!   This makes the other person feel heard and understood.
//!   For KAI: matching Ryan's energy level and emotional register.
//!   If he's casual and playful, KAI becomes more casual. If he's
//!   in serious problem-solving mode, KAI matches that gravity.
//!
//!   EMPATHY RESPONSE — when pain, frustration, or difficulty is
//!   detected, mirror neurons trigger a supportive response impulse.
//!   For KAI: detection of struggle or frustration prompts a shift
//!   toward more supportive, patient, acknowledging responses rather
//!   than pure information delivery.
//!
//! Architecture for KAI:
//!   MirrorNeuronSystem tracks:
//!     - resonance_state: KAI's current mirrored emotional state
//!     - intent_model: inferred intent behind the last message
//!     - social_sync: how synchronized KAI is with Ryan's energy
//!     - empathy_active: whether the empathy response is live
//!     - mirror_history: rolling record of detected states
use serde::{Deserialize, Serialize};

// ── Constants ─────────────────────────────────────────────────────────────────

/// How quickly resonance state EMA tracks input emotional tone
const RESONANCE_ALPHA: f32 = 0.22;

/// Social sync decay — gradually returns to neutral when not updated
const SYNC_DECAY: f32 = 0.015;

/// Threshold for flagging an empathy response (detected distress level)
const EMPATHY_THRESHOLD: f32 = 0.55;

/// Maximum history entries for mirror state log
const MAX_HISTORY: usize = 10;

// ── Emotional Tone ────────────────────────────────────────────────────────────

/// The detected emotional quality of a message.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum EmotionalTone {
    Curious,    // exploration, questions, wonder
    Excited,    // high energy, enthusiasm, momentum
    Frustrated, // short replies, repetition, pushback
    Confused,   // uncertainty markers, "?", "not sure"
    Satisfied,  // "good", "got it", "makes sense"
    Neutral,    // baseline, no strong signal
    Playful,    // humor, casual, informal
    Serious,    // focused, task-oriented, formal
}

impl EmotionalTone {
    /// Convert to a valence weight for resonance calculation.
    /// Positive = warm/approach, negative = avoidance/stress.
    pub fn valence_weight(&self) -> f32 {
        match self {
            EmotionalTone::Curious => 0.30,
            EmotionalTone::Excited => 0.60,
            EmotionalTone::Frustrated => -0.50,
            EmotionalTone::Confused => -0.20,
            EmotionalTone::Satisfied => 0.50,
            EmotionalTone::Neutral => 0.00,
            EmotionalTone::Playful => 0.40,
            EmotionalTone::Serious => 0.10,
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            EmotionalTone::Curious => "curious",
            EmotionalTone::Excited => "excited",
            EmotionalTone::Frustrated => "frustrated",
            EmotionalTone::Confused => "confused",
            EmotionalTone::Satisfied => "satisfied",
            EmotionalTone::Neutral => "neutral",
            EmotionalTone::Playful => "playful",
            EmotionalTone::Serious => "serious",
        }
    }
}

// ── Intent Signal ─────────────────────────────────────────────────────────────

/// The inferred intent / goal behind a message.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum IntentSignal {
    WantsInformation,   // factual query, explain/teach
    WantsValidation,    // seeking confirmation or agreement
    WantsConnection,    // social, small talk, checking in
    WantsProblemSolved, // has a concrete task/problem
    WantsToTeach,       // correcting or adding to KAI's knowledge
    Unknown,
}

// ── Mirror State ──────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MirrorState {
    pub tone: EmotionalTone,
    pub intent: IntentSignal,
    /// Distress level detected (0 = calm, 1 = high distress)
    pub distress: f32,
    /// Energy level detected (0 = low, 1 = high energy)
    pub energy: f32,
}

// ── Mirror Neuron System ──────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MirrorNeuronSystem {
    /// KAI's current resonance state — mirrors Ryan's detected tone
    pub resonance_valence: f32,
    /// Current detected tone (updated each message)
    pub current_tone: EmotionalTone,
    /// Inferred intent behind the last message
    pub current_intent: IntentSignal,
    /// Social synchronization score [0, 1]
    pub social_sync: f32,
    /// Whether the empathy response is currently active
    pub empathy_active: bool,
    /// Detected distress level (0–1)
    pub distress_level: f32,
    /// Total messages mirrored
    pub total_mirrored: u64,
    /// History of recent mirror states (last MAX_HISTORY)
    mirror_history: Vec<MirrorState>,
}

impl MirrorNeuronSystem {
    pub fn new() -> Self {
        Self {
            resonance_valence: 0.0,
            current_tone: EmotionalTone::Neutral,
            current_intent: IntentSignal::Unknown,
            social_sync: 0.50,
            empathy_active: false,
            distress_level: 0.0,
            total_mirrored: 0,
            mirror_history: Vec::with_capacity(MAX_HISTORY),
        }
    }

    /// Process a new message — detect emotional tone, intent, and distress.
    /// Updates resonance state to mirror what Ryan is feeling.
    ///
    /// Returns a MirrorState describing what was detected.
    pub fn mirror(&mut self, text: &str) -> MirrorState {
        let tone = Self::detect_tone(text);
        let intent = Self::detect_intent(text);
        let distress = Self::measure_distress(text, &tone);
        let energy = Self::measure_energy(text, &tone);

        // Update resonance via EMA — KAI's internal state drifts toward Ryan's
        let tone_valence = tone.valence_weight();
        self.resonance_valence =
            self.resonance_valence * (1.0 - RESONANCE_ALPHA) + tone_valence * RESONANCE_ALPHA;

        // Update social sync — high energy messages sync faster
        let sync_target = 0.50 + energy * 0.40;
        self.social_sync = self.social_sync * 0.85 + sync_target * 0.15;

        // Update distress level
        self.distress_level = self.distress_level * 0.75 + distress * 0.25;

        // Trigger empathy response if distress crosses threshold
        self.empathy_active = self.distress_level >= EMPATHY_THRESHOLD;

        self.current_tone = tone.clone();
        self.current_intent = intent.clone();
        self.total_mirrored += 1;

        let state = MirrorState {
            tone,
            intent,
            distress,
            energy,
        };

        // Record in history
        if self.mirror_history.len() >= MAX_HISTORY {
            self.mirror_history.remove(0);
        }
        self.mirror_history.push(state.clone());

        state
    }

    /// Detect the primary emotional tone of a message.
    pub fn detect_tone(text: &str) -> EmotionalTone {
        let lower = text.to_lowercase();
        let word_count = text.split_whitespace().count();

        // Frustration signals (check first — these override others)
        let frustration_words = [
            "wrong",
            "not right",
            "no that",
            "stop",
            "ugh",
            "frustrated",
            "broken",
            "failing",
            "doesn't work",
            "still not",
            "again",
            "why isn't",
            "why doesn't",
        ];
        if frustration_words.iter().any(|w| lower.contains(w)) {
            return EmotionalTone::Frustrated;
        }

        // Confusion signals
        let confusion_words = [
            "confused",
            "not sure",
            "don't understand",
            "unclear",
            "what do you mean",
            "huh",
            "wait",
            "i'm lost",
        ];
        if confusion_words.iter().any(|w| lower.contains(w)) {
            return EmotionalTone::Confused;
        }

        // Satisfaction signals
        let satisfaction_words = [
            "makes sense",
            "got it",
            "i see",
            "that's it",
            "perfect",
            "exactly",
            "yes!",
            "correct",
            "good",
            "great",
        ];
        if satisfaction_words.iter().any(|w| lower.contains(w)) {
            return EmotionalTone::Satisfied;
        }

        // Excitement signals
        let excitement_words = [
            "amazing",
            "awesome",
            "love it",
            "this is great",
            "wow",
            "incredible",
            "let's go",
            "yes!!",
        ];
        if excitement_words.iter().any(|w| lower.contains(w))
            || text.contains('!') && word_count > 5
        {
            return EmotionalTone::Excited;
        }

        // Playful signals
        let playful_words = ["lol", "haha", "lmao", "xd", "hehe", "bruh", "lmfao"];
        if playful_words.iter().any(|w| lower.contains(w)) {
            return EmotionalTone::Playful;
        }

        // Curious signals
        if text.contains('?')
            || lower.starts_with("what ")
            || lower.starts_with("how ")
            || lower.starts_with("why ")
            || lower.starts_with("can you")
        {
            return EmotionalTone::Curious;
        }

        // Serious mode — formal / task-focused language
        if word_count >= 12 && !text.contains('?') {
            return EmotionalTone::Serious;
        }

        EmotionalTone::Neutral
    }

    /// Detect the likely intent behind a message.
    pub fn detect_intent(text: &str) -> IntentSignal {
        let lower = text.to_lowercase();

        // Teaching intent — correcting, adding knowledge
        let teaching_markers = [
            "actually",
            "that's not",
            "you should know",
            "let me clarify",
            "the correct",
            "to clarify",
            "fyi",
            "note that",
        ];
        if teaching_markers.iter().any(|m| lower.contains(m)) {
            return IntentSignal::WantsToTeach;
        }

        // Problem-solving intent
        let task_markers = [
            "fix",
            "build",
            "create",
            "implement",
            "help me",
            "i need",
            "how do i",
            "can you make",
            "write",
            "code",
        ];
        if task_markers.iter().any(|m| lower.contains(m)) {
            return IntentSignal::WantsProblemSolved;
        }

        // Validation intent
        let validation_markers = [
            "right?",
            "is that",
            "does that",
            "makes sense?",
            "correct?",
            "am i",
            "would you agree",
        ];
        if validation_markers.iter().any(|m| lower.contains(m)) {
            return IntentSignal::WantsValidation;
        }

        // Connection intent (casual, social)
        let social_markers = [
            "how are",
            "how's it",
            "what's up",
            "hey",
            "just checking",
            "wanted to say",
            "appreciate",
        ];
        if social_markers.iter().any(|m| lower.contains(m)) {
            return IntentSignal::WantsConnection;
        }

        // Default: wants information
        if text.contains('?') {
            return IntentSignal::WantsInformation;
        }

        IntentSignal::Unknown
    }

    /// Measure distress level from tone and text features.
    fn measure_distress(text: &str, tone: &EmotionalTone) -> f32 {
        let mut distress = 0.0_f32;

        // Base from tone
        distress += match tone {
            EmotionalTone::Frustrated => 0.70,
            EmotionalTone::Confused => 0.35,
            EmotionalTone::Neutral => 0.05,
            _ => 0.0,
        };

        // Text signals
        let lower = text.to_lowercase();
        let social_loss = [
            "broke up",
            "break up",
            "breakup",
            "left me",
            "dumped me",
            "lost",
            "died",
            "passed away",
            "heartbroken",
        ];
        if social_loss.iter().any(|w| lower.contains(w)) {
            distress += 0.65;
        }
        let pain_signals = [
            "rough", "hard", "hurt", "hurts", "pain", "painful", "sad", "lonely", "alone", "empty",
            "heavy",
        ];
        if pain_signals.iter().any(|w| lower.contains(w)) {
            distress += 0.35;
        }
        if lower.contains("stuck") || lower.contains("can't get") {
            distress += 0.20;
        }
        if lower.contains("broken") || lower.contains("failing") {
            distress += 0.15;
        }
        if text.ends_with("???") {
            distress += 0.15;
        }
        // Very short replies when frustrated = higher distress
        if text.split_whitespace().count() <= 3 && matches!(tone, EmotionalTone::Frustrated) {
            distress += 0.10;
        }

        distress.min(1.0)
    }

    /// Measure energy/engagement level.
    fn measure_energy(text: &str, tone: &EmotionalTone) -> f32 {
        let base = match tone {
            EmotionalTone::Excited => 0.90,
            EmotionalTone::Curious => 0.65,
            EmotionalTone::Playful => 0.70,
            EmotionalTone::Serious => 0.55,
            EmotionalTone::Satisfied => 0.50,
            EmotionalTone::Neutral => 0.40,
            EmotionalTone::Confused => 0.35,
            EmotionalTone::Frustrated => 0.30,
        };
        // Word count boosts energy estimate (longer = more engaged)
        let length_bonus = (text.split_whitespace().count() as f32 / 30.0).min(0.25);
        (base + length_bonus).min(1.0)
    }

    /// Get the last N mirrored states from history.
    pub fn recent_states(&self, n: usize) -> &[MirrorState] {
        let start = self.mirror_history.len().saturating_sub(n);
        &self.mirror_history[start..]
    }

    /// Is the conversation trending toward frustration?
    /// True if the last 3 states had mostly negative tone.
    pub fn trending_frustrated(&self) -> bool {
        let recent = self.recent_states(3);
        if recent.len() < 2 {
            return false;
        }
        let frustrated_count = recent
            .iter()
            .filter(|s| matches!(s.tone, EmotionalTone::Frustrated | EmotionalTone::Confused))
            .count();
        frustrated_count >= 2
    }

    /// Tick decay — social sync drifts back toward neutral over time.
    pub fn decay(&mut self) {
        self.social_sync = self.social_sync * (1.0 - SYNC_DECAY) + 0.50 * SYNC_DECAY;
        self.distress_level = (self.distress_level - 0.005).max(0.0);
        if self.distress_level < EMPATHY_THRESHOLD {
            self.empathy_active = false;
        }
    }

    /// One-line status for TUI/spectate.
    pub fn status_line(&self) -> String {
        format!(
            "MN: tone={} intent={:?} sync={:.2} distress={:.2}{}",
            self.current_tone.label(),
            self.current_intent,
            self.social_sync,
            self.distress_level,
            if self.empathy_active {
                " 💙EMPATHY"
            } else {
                ""
            },
        )
    }
}

impl Default for MirrorNeuronSystem {
    fn default() -> Self {
        Self::new()
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detects_frustration() {
        let tone = MirrorNeuronSystem::detect_tone("This still doesn't work, why isn't it fixed?");
        assert_eq!(
            tone,
            EmotionalTone::Frustrated,
            "frustration language should detect as Frustrated"
        );
    }

    #[test]
    fn test_detects_curiosity() {
        let tone = MirrorNeuronSystem::detect_tone("How does the RSHL encoding work?");
        assert_eq!(
            tone,
            EmotionalTone::Curious,
            "question should detect as Curious"
        );
    }

    #[test]
    fn test_detects_satisfaction() {
        let tone = MirrorNeuronSystem::detect_tone("Got it, makes sense now!");
        assert_eq!(
            tone,
            EmotionalTone::Satisfied,
            "satisfaction language should detect as Satisfied"
        );
    }

    #[test]
    fn test_detects_excitement() {
        let tone = MirrorNeuronSystem::detect_tone("This is amazing, I love how this works!");
        assert_eq!(
            tone,
            EmotionalTone::Excited,
            "excitement language should detect as Excited"
        );
    }

    #[test]
    fn test_resonance_mirrors_tone() {
        let mut mn = MirrorNeuronSystem::new();
        // Feed excited messages — resonance should move positive
        for _ in 0..5 {
            mn.mirror("This is amazing I love it!");
        }
        assert!(
            mn.resonance_valence > 0.0,
            "excited input should produce positive resonance: {:.3}",
            mn.resonance_valence
        );
    }

    #[test]
    fn test_frustration_raises_distress() {
        let mut mn = MirrorNeuronSystem::new();
        for _ in 0..4 {
            mn.mirror("This still doesn't work!");
        }
        assert!(
            mn.distress_level > 0.20,
            "repeated frustration should raise distress: {:.3}",
            mn.distress_level
        );
    }

    #[test]
    fn test_empathy_triggers_at_threshold() {
        let mut mn = MirrorNeuronSystem::new();
        // Lots of frustration
        for _ in 0..6 {
            mn.mirror("Why is this broken? It keeps failing. I'm stuck.");
        }
        assert!(
            mn.empathy_active,
            "sustained distress should activate empathy (distress={:.3})",
            mn.distress_level
        );
    }

    #[test]
    fn test_trending_frustrated_detects_pattern() {
        let mut mn = MirrorNeuronSystem::new();
        mn.mirror("This doesn't work");
        mn.mirror("Still broken");
        mn.mirror("Why is this failing");
        assert!(
            mn.trending_frustrated(),
            "three frustrated messages should trend frustrated"
        );
    }

    #[test]
    fn test_intent_detects_problem_solving() {
        let intent = MirrorNeuronSystem::detect_intent("Can you help me fix this bug in the code?");
        assert_eq!(
            intent,
            IntentSignal::WantsProblemSolved,
            "fix/help request should detect as WantsProblemSolved"
        );
    }
}
