/// Superior Temporal Sulcus (STS) — Biological Motion, Social Intent Reading
///
/// The STS is the brain's specialized social signal processor. It reads
/// non-verbal cues, detects the difference between intentional and random
/// motion, and predicts what an agent will do next based on trajectory.
///
/// Key functions:
///
///   Biological motion detection:
///     The STS responds specifically to motion produced by living agents.
///     It distinguishes "a person moving" from "an object moving."
///     In language: it distinguishes "someone deliberately doing X" from
///     "X is happening." Active intent vs. passive occurrence.
///
///   Social intent prediction:
///     Given someone's recent actions and current state, the STS predicts
///     what they are TRYING to do — their proximal goal.
///     "Ryan is asking a lot of questions → he's trying to understand something."
///     "Ryan said 'let's continue' → he wants momentum, not summary."
///
///   Communicative intent reading:
///     Beyond literal meaning: what is Ryan TRYING to communicate?
///     The STS works with Theory of Mind but at the action-prediction level,
///     not the belief level. ToM asks "what does he believe?" — STS asks
///     "what is he trying to do right now?"
///
///   Voice/prosody sensitivity (in biological brains):
///     The STS reads emotional prosody — tone of voice.
///     In text, this maps to: word choice intensity, punctuation, caps,
///     question vs. statement structure, urgency markers.
///
/// KAI's STS:
///   action_sequence: recent user behaviors (query types, energy levels)
///   current_goal_estimate: what Ryan is trying to accomplish right now
///   social_trajectory: is the interaction deepening, plateauing, or ending?
///   intent_confidence: how sure is the STS about its goal estimate?
///
/// Integration:
///   STS output feeds into Theory of Mind (higher-level belief modeling)
///   and into voice.rs (shapes whether KAI leans in, wraps up, or pivots)

use std::collections::VecDeque;

// ── Constants ─────────────────────────────────────────────────────────────────

/// Window of recent actions to analyze for trajectory
const ACTION_WINDOW: usize = 6;

/// Minimum trajectory length before goal estimation is confident
const CONFIDENCE_FLOOR_ACTIONS: usize = 2;

// ── SocialGoal ────────────────────────────────────────────────────────────────

/// The STS's estimate of what Ryan is trying to accomplish
#[derive(Debug, Clone, PartialEq)]
pub enum SocialGoal {
    /// Seeking to understand a specific concept
    BuildingUnderstanding,
    /// Testing or validating a hypothesis
    ValidatingIdea,
    /// Working toward a concrete outcome (code, file, result)
    TaskCompletion,
    /// Exploring a space without a fixed destination
    OpenExploration,
    /// Maintaining connection / social engagement
    SocialEngagement,
    /// Expressing frustration or seeking acknowledgment
    EmotionalExpression,
    /// Wrapping up / preparing to disengage
    WindingDown,
    /// Not yet enough data
    Unknown,
}

impl SocialGoal {
    pub fn label(&self) -> &'static str {
        match self {
            Self::BuildingUnderstanding => "building-understanding",
            Self::ValidatingIdea        => "validating-idea",
            Self::TaskCompletion        => "task-completion",
            Self::OpenExploration       => "open-exploration",
            Self::SocialEngagement      => "social-engagement",
            Self::EmotionalExpression   => "emotional-expression",
            Self::WindingDown           => "winding-down",
            Self::Unknown               => "unknown",
        }
    }
}

// ── SocialTrajectory ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum SocialTrajectory {
    /// Interaction depth is increasing
    Deepening,
    /// Interaction is stable at current depth
    Stable,
    /// Interaction is becoming shallower
    Withdrawing,
    /// Too few data points
    Undetermined,
}

// ── ActionRecord ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct ActionRecord {
    /// Message word count
    word_count: usize,
    /// Emotional charge
    charge: f32,
    /// Whether it was a question
    is_question: bool,
    /// Whether it was task-directed
    is_task: bool,
}

// ── STSReading ────────────────────────────────────────────────────────────────

/// The STS's social reading of the current state
#[derive(Debug, Clone)]
pub struct STSReading {
    /// Estimated current goal
    pub goal: SocialGoal,
    /// Confidence in goal estimate (0.0–1.0)
    pub intent_confidence: f32,
    /// Social trajectory
    pub trajectory: SocialTrajectory,
    /// Whether KAI should lean in (continue thread) or create space
    pub lean_in: bool,
    /// Whether this looks like an ending/wrap-up
    pub winding_down: bool,
}

// ── STS ───────────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct STS {
    /// Recent action sequence
    action_sequence: VecDeque<ActionRecord>,
    /// Current goal estimate
    pub current_goal: SocialGoal,
    /// Current trajectory
    pub trajectory: SocialTrajectory,
    /// Intent confidence
    pub intent_confidence: f32,
    /// Total readings produced
    pub total_readings: u64,
    /// Running average word count (for trajectory)
    avg_word_count: f32,
}

impl STS {
    pub fn new() -> Self {
        Self {
            action_sequence:  VecDeque::with_capacity(ACTION_WINDOW),
            current_goal:     SocialGoal::Unknown,
            trajectory:       SocialTrajectory::Undetermined,
            intent_confidence: 0.0,
            total_readings:   0,
            avg_word_count:   20.0,
        }
    }

    // ── Core: read social signal ──────────────────────────────────────────────

    /// Process a new user message and update social goal estimate.
    /// Returns the full STSReading.
    pub fn read(&mut self, text: &str, emotional_charge: f32) -> STSReading {
        let words: Vec<&str> = text.split_whitespace().collect();
        let word_count = words.len();
        let lower = text.to_lowercase();

        let is_question = lower.ends_with('?')
            || lower.starts_with("what")
            || lower.starts_with("how")
            || lower.starts_with("why")
            || lower.starts_with("can you")
            || lower.starts_with("do you");

        let task_words = ["create", "make", "build", "write", "fix", "run",
                         "implement", "generate", "analyze", "code", "edit"];
        let is_task = task_words.iter().any(|t| lower.contains(t));

        // Add to action sequence
        if self.action_sequence.len() >= ACTION_WINDOW {
            self.action_sequence.pop_front();
        }
        self.action_sequence.push_back(ActionRecord {
            word_count, charge: emotional_charge, is_question, is_task,
        });

        // Update average word count (for trajectory)
        let n = self.action_sequence.len() as f32;
        self.avg_word_count = self.action_sequence.iter()
            .map(|a| a.word_count as f32)
            .sum::<f32>() / n;

        // Estimate goal
        self.current_goal = self.estimate_goal(&lower);

        // Estimate trajectory
        self.trajectory = self.estimate_trajectory();

        // Compute confidence
        self.intent_confidence = if self.action_sequence.len() >= CONFIDENCE_FLOOR_ACTIONS {
            (0.40 + (self.action_sequence.len() as f32 / ACTION_WINDOW as f32) * 0.50).min(0.90)
        } else {
            0.25
        };

        self.total_readings += 1;

        let lean_in = matches!(self.current_goal,
            SocialGoal::BuildingUnderstanding | SocialGoal::OpenExploration |
            SocialGoal::ValidatingIdea)
            && matches!(self.trajectory, SocialTrajectory::Deepening | SocialTrajectory::Stable);

        let winding_down = matches!(self.current_goal, SocialGoal::WindingDown)
            || matches!(self.trajectory, SocialTrajectory::Withdrawing);

        STSReading {
            goal: self.current_goal.clone(),
            intent_confidence: self.intent_confidence,
            trajectory: self.trajectory.clone(),
            lean_in,
            winding_down,
        }
    }

    /// Estimate the current social goal from recent action sequence + current text.
    fn estimate_goal(&self, lower: &str) -> SocialGoal {
        let recent = self.action_sequence.iter().collect::<Vec<_>>();
        if recent.is_empty() { return SocialGoal::Unknown; }

        // Wind-down signals
        let wind_down = ["thanks", "thank you", "that's all", "goodbye", "bye",
                        "good night", "later", "done for now", "that's it"];
        if wind_down.iter().any(|w| lower.contains(w)) {
            return SocialGoal::WindingDown;
        }

        // Task completion signals
        let task_count = recent.iter().filter(|a| a.is_task).count();
        if task_count >= 2 || (recent.last().map(|a| a.is_task).unwrap_or(false) && task_count >= 1) {
            return SocialGoal::TaskCompletion;
        }

        // Emotional expression
        let high_charge = recent.iter().filter(|a| a.charge > 0.60).count();
        if high_charge >= 2 {
            return SocialGoal::EmotionalExpression;
        }

        // Social engagement (very short, warm)
        let social_words = ["awesome", "great", "nice", "cool", "wow",
                           "yes!", "exactly", "perfect", "love"];
        if social_words.iter().any(|w| lower.contains(w)) && lower.split_whitespace().count() < 6 {
            return SocialGoal::SocialEngagement;
        }

        // Exploration signals
        let explore = ["wonder", "thinking", "maybe", "what if", "imagine",
                      "curious", "interesting", "explore"];
        if explore.iter().any(|w| lower.contains(w)) {
            return SocialGoal::OpenExploration;
        }

        // Validating signals
        let validate = ["right?", "correct?", "makes sense", "is this",
                       "am i", "would you say", "do you think"];
        if validate.iter().any(|w| lower.contains(w)) {
            return SocialGoal::ValidatingIdea;
        }

        // Building understanding: sustained questioning
        let question_count = recent.iter().filter(|a| a.is_question).count();
        let avg_len = self.avg_word_count;
        if question_count >= 2 || (question_count >= 1 && avg_len > 12.0) {
            return SocialGoal::BuildingUnderstanding;
        }

        // Default for long substantive messages
        if recent.last().map(|a| a.word_count).unwrap_or(0) > 10 {
            return SocialGoal::BuildingUnderstanding;
        }

        SocialGoal::Unknown
    }

    /// Estimate the social trajectory from action sequence trends.
    fn estimate_trajectory(&self) -> SocialTrajectory {
        if self.action_sequence.len() < 3 {
            return SocialTrajectory::Undetermined;
        }

        let recent: Vec<_> = self.action_sequence.iter().collect();
        let n = recent.len();
        let first_half_avg = recent[..n/2].iter().map(|a| a.word_count as f32).sum::<f32>()
            / (n/2) as f32;
        let second_half_avg = recent[n/2..].iter().map(|a| a.word_count as f32).sum::<f32>()
            / (n - n/2) as f32;

        let delta = second_half_avg - first_half_avg;
        match delta {
            d if d > 5.0  => SocialTrajectory::Deepening,
            d if d < -5.0 => SocialTrajectory::Withdrawing,
            _              => SocialTrajectory::Stable,
        }
    }

    /// Status line for brain monitor.
    pub fn status_line(&self) -> String {
        format!(
            "STS goal={} conf={:.2} traj={:?} | readings={}",
            self.current_goal.label(),
            self.intent_confidence,
            self.trajectory,
            self.total_readings,
        )
    }
}

impl Default for STS {
    fn default() -> Self { Self::new() }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_initial_state() {
        let sts = STS::new();
        assert_eq!(sts.current_goal, SocialGoal::Unknown);
        assert_eq!(sts.trajectory, SocialTrajectory::Undetermined);
    }

    #[test]
    fn test_question_sequence_building_understanding() {
        let mut sts = STS::new();
        sts.read("how does the hippocampus work?", 0.3);
        sts.read("what is pattern completion exactly?", 0.3);
        sts.read("why does it need the dentate gyrus?", 0.3);
        let reading = sts.read("how does that relate to memory consolidation?", 0.3);
        assert_eq!(reading.goal, SocialGoal::BuildingUnderstanding,
            "sustained questioning should be BuildingUnderstanding");
    }

    #[test]
    fn test_task_sequence_task_completion() {
        let mut sts = STS::new();
        sts.read("can you build a new module for KAI", 0.4);
        let reading = sts.read("write the tests for it too", 0.4);
        assert_eq!(reading.goal, SocialGoal::TaskCompletion,
            "consecutive task requests should be TaskCompletion");
    }

    #[test]
    fn test_wind_down_detection() {
        let mut sts = STS::new();
        sts.read("that looks good", 0.2);
        let reading = sts.read("thanks for all your help today", 0.2);
        assert_eq!(reading.goal, SocialGoal::WindingDown);
    }

    #[test]
    fn test_exploration_detection() {
        let mut sts = STS::new();
        let reading = sts.read("i wonder if geometry could be the basis of consciousness", 0.4);
        assert_eq!(reading.goal, SocialGoal::OpenExploration);
    }

    #[test]
    fn test_lean_in_for_exploration() {
        let mut sts = STS::new();
        sts.read("i wonder about consciousness and geometry", 0.4);
        sts.read("what if RSHL is related to awareness somehow", 0.4);
        let reading = sts.read("i keep thinking about recursive self-reference", 0.4);
        // Should lean in for open exploration
        if reading.goal == SocialGoal::OpenExploration || reading.goal == SocialGoal::BuildingUnderstanding {
            assert!(reading.lean_in, "exploration/understanding should trigger lean-in");
        }
    }

    #[test]
    fn test_winding_down_no_lean_in() {
        let mut sts = STS::new();
        sts.read("that's good", 0.2);
        let reading = sts.read("thanks that's all I needed", 0.2);
        assert!(reading.winding_down, "wind-down should be detected");
        assert!(!reading.lean_in, "winding down should not trigger lean-in");
    }

    #[test]
    fn test_confidence_rises_with_history() {
        let mut sts = STS::new();
        let r1 = sts.read("what is this", 0.2);
        let _r2 = sts.read("and how does it work", 0.2);
        let r3 = sts.read("can you explain more about the details", 0.2);
        assert!(r3.intent_confidence > r1.intent_confidence,
            "confidence should rise with more history: {:.2} → {:.2}",
            r1.intent_confidence, r3.intent_confidence);
    }

    #[test]
    fn test_deepening_trajectory() {
        let mut sts = STS::new();
        // Start with short messages, then longer ones
        sts.read("ok", 0.2);
        sts.read("yes", 0.2);
        sts.read("sure", 0.2);
        // Now much longer messages
        sts.read("actually I want to understand how the VTA tonic vs phasic distinction works in detail", 0.4);
        sts.read("and how it relates to the NAc wanting signal and flow state in KAI", 0.4);
        sts.read("especially the mesocortical pathway and PFC working memory modulation", 0.4);
        let reading = sts.read("can you also explain how it connects to the dopamine circuit we already have", 0.4);
        assert_eq!(reading.trajectory, SocialTrajectory::Deepening,
            "increasing message length should be Deepening trajectory");
    }

    #[test]
    fn test_status_line() {
        let sts = STS::new();
        let s = sts.status_line();
        assert!(s.contains("STS"), "status should mention STS");
    }
}
