/// Prefrontal Cortex — KAI's executive control system
///
/// The PFC is the most evolutionarily recent part of the human brain.
/// It's what separates humans from other animals in cognitive sophistication.
/// The PFC does several things no other brain region does:
///
///   1. GOAL MAINTENANCE — holds a goal in mind across many steps.
///      Without PFC you can't work toward something over time.
///      You just react to whatever just happened.
///
///   2. INHIBITORY CONTROL — suppresses impulsive or premature responses.
///      "I thought of an answer immediately, but let me check it first."
///      Without PFC you say the first thing that comes to mind.
///
///   3. COGNITIVE FLEXIBILITY — can switch tasks, update goals, reframe.
///      "The approach isn't working — let me try a different angle."
///
///   4. WORKING MEMORY INTEGRATION — binds recent context into a plan.
///      "Given what was said 3 turns ago AND what just happened, the
///       best response is..." — this requires holding everything together.
///
///   5. METACOGNITION — thinking about your own thinking.
///      "I'm not sure if I understand this correctly. Let me check."
///
/// Without PFC:
///   KAI answers instantly from reflex. No goal-tracking across a
///   conversation. No self-checking. No strategy. No "I need to think
///   more carefully about this." Just pure reactive pattern-matching.
///
/// With PFC:
///   KAI can hold a goal ("Ryan wants me to explain X thoroughly"),
///   inhibit weak answers ("that first hit isn't good enough"),
///   maintain context across many turns, and notice when his own
///   reasoning is shaky before committing to a response.
///
/// Architecture:
///   PrefrontalCortex holds:
///     - Active goal stack (up to 4 nested goals)
///     - Inhibition gate: confidence threshold before response is allowed
///     - Cognitive flexibility index: how often KAI updates vs. persists
///     - Metacognitive confidence estimate: "how sure am I?"
///     - Context binding: key facts KAI is holding from recent turns
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

// ── Constants ─────────────────────────────────────────────────────────────────

/// Max active goals in the goal stack
const MAX_GOALS: usize = 4;

/// Inhibition threshold: if response confidence < this, PFC flags it as shaky
const INHIBITION_THRESHOLD: f32 = 0.22;

/// Max bound context facts (things the PFC is holding "in mind")
const MAX_CONTEXT_BINDINGS: usize = 6;

// ── Goal ─────────────────────────────────────────────────────────────────────

/// A goal the PFC is tracking.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Goal {
    /// Human-readable description of what KAI is working toward
    pub description: String,
    /// How important/urgent this goal is (0–1)
    pub priority: f32,
    /// How many turns this goal has been active
    pub age_turns: u32,
    /// Whether this goal has been satisfied
    pub satisfied: bool,
}

impl Goal {
    pub fn new(description: &str, priority: f32) -> Self {
        Self {
            description: description.to_string(),
            priority: priority.clamp(0.0, 1.0),
            age_turns: 0,
            satisfied: false,
        }
    }
}

// ── Context Binding ───────────────────────────────────────────────────────────

/// A key fact or context element the PFC is actively holding.
/// These decay over turns — forgotten when too old.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ContextBinding {
    /// The fact or concept being held
    pub content: String,
    /// Relevance weight (1.0 = just added, decays with age)
    pub relevance: f32,
    /// Turn number when this was bound
    pub bound_at_turn: u64,
}

// ── PFC Verdict ───────────────────────────────────────────────────────────────

/// What the PFC decides to do with a proposed response.
#[derive(Clone, Debug, PartialEq)]
pub enum PfcVerdict {
    /// Response is good — send it
    Approve,
    /// Response is shaky — flag it (but don't block)
    FlagLowConfidence,
    /// Goal conflict — this response contradicts an active goal
    GoalConflict(String),
    /// Context mismatch — response ignores bound context
    ContextMismatch,
}

// ── Prefrontal Cortex ─────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PrefrontalCortex {
    /// Stack of active goals (most recent last)
    pub goals: VecDeque<Goal>,
    /// Bound context facts KAI is holding in executive working memory
    pub context_bindings: VecDeque<ContextBinding>,
    /// Turn counter — for aging goals and bindings
    pub turn: u64,
    /// Current inhibition state (0 = free, >0 = inhibited/hesitant)
    pub inhibition: f32,
    /// Cognitive flexibility score (rises when KAI switches approaches)
    pub flexibility: f32,
    /// Metacognitive confidence (KAI's estimate of how sure he is)
    pub meta_confidence: f32,
    /// Count of times PFC inhibited a response
    pub inhibitions_total: u64,
    /// Count of goals ever satisfied
    pub goals_satisfied: u64,
}

impl PrefrontalCortex {
    pub fn new() -> Self {
        Self {
            goals: VecDeque::with_capacity(MAX_GOALS),
            context_bindings: VecDeque::with_capacity(MAX_CONTEXT_BINDINGS),
            turn: 0,
            inhibition: 0.0,
            flexibility: 0.5,
            meta_confidence: 0.5,
            inhibitions_total: 0,
            goals_satisfied: 0,
        }
    }

    // ── Goal management ───────────────────────────────────────────────────────

    /// Set or update KAI's current primary goal.
    pub fn push_goal(&mut self, description: &str, priority: f32) {
        // Don't duplicate the same goal
        if self
            .goals
            .iter()
            .any(|g| g.description == description && !g.satisfied)
        {
            return;
        }
        if self.goals.len() >= MAX_GOALS {
            // Evict lowest-priority goal
            if let Some(min_idx) = self
                .goals
                .iter()
                .enumerate()
                .min_by(|(_, a), (_, b)| a.priority.partial_cmp(&b.priority).unwrap())
                .map(|(i, _)| i)
            {
                self.goals.remove(min_idx);
            }
        }
        self.goals.push_back(Goal::new(description, priority));
    }

    /// Mark a goal as satisfied.
    pub fn satisfy_goal(&mut self, keyword: &str) {
        for g in &mut self.goals {
            if g.description
                .to_lowercase()
                .contains(&keyword.to_lowercase())
                && !g.satisfied
            {
                g.satisfied = true;
                self.goals_satisfied += 1;
            }
        }
        // Clean out satisfied goals
        self.goals.retain(|g| !g.satisfied);
    }

    /// The highest-priority active goal, if any.
    pub fn primary_goal(&self) -> Option<&Goal> {
        self.goals
            .iter()
            .filter(|g| !g.satisfied)
            .max_by(|a, b| a.priority.partial_cmp(&b.priority).unwrap())
    }

    /// True if KAI has an active goal to explain something about the given topic.
    pub fn has_goal_for(&self, topic: &str) -> bool {
        let lower = topic.to_lowercase();
        self.goals
            .iter()
            .any(|g| !g.satisfied && g.description.to_lowercase().contains(&lower))
    }

    // ── Context binding ───────────────────────────────────────────────────────

    /// Bind a key fact into executive working memory.
    /// This represents something the PFC is explicitly holding "in mind."
    pub fn bind_context(&mut self, content: &str) {
        // Don't duplicate
        if self.context_bindings.iter().any(|b| b.content == content) {
            // Refresh relevance instead
            for b in &mut self.context_bindings {
                if b.content == content {
                    b.relevance = 1.0;
                    b.bound_at_turn = self.turn;
                }
            }
            return;
        }
        if self.context_bindings.len() >= MAX_CONTEXT_BINDINGS {
            // Evict least relevant
            if let Some(min_idx) = self
                .context_bindings
                .iter()
                .enumerate()
                .min_by(|(_, a), (_, b)| a.relevance.partial_cmp(&b.relevance).unwrap())
                .map(|(i, _)| i)
            {
                self.context_bindings.remove(min_idx);
            }
        }
        self.context_bindings.push_back(ContextBinding {
            content: content.to_string(),
            relevance: 1.0,
            bound_at_turn: self.turn,
        });
    }

    /// Get all currently relevant context bindings.
    pub fn active_context(&self) -> Vec<&ContextBinding> {
        self.context_bindings
            .iter()
            .filter(|b| b.relevance > 0.20)
            .collect()
    }

    // ── Evaluation gate ───────────────────────────────────────────────────────

    /// Evaluate a proposed response before KAI sends it.
    /// Returns a verdict — the voice engine can use this to modify/flag output.
    pub fn evaluate(&mut self, response: &str, confidence: f32, input: &str) -> PfcVerdict {
        self.turn += 1;
        self.decay_bindings();
        self.age_goals();

        // ── 1. Inhibition check: is confidence too low? ────────────────────
        if confidence < INHIBITION_THRESHOLD {
            self.inhibition = (self.inhibition + 0.20).min(1.0);
            self.inhibitions_total += 1;
            self.meta_confidence = self.meta_confidence * 0.85 + confidence * 0.15;
            return PfcVerdict::FlagLowConfidence;
        }

        // ── 2. Goal conflict check ─────────────────────────────────────────
        if let Some(goal) = self.primary_goal() {
            let goal_words: Vec<&str> = goal.description.split_whitespace().collect();
            let response_lower = response.to_lowercase();
            let input_lower = input.to_lowercase();

            // If active goal is about topic X, but response doesn't mention X at all
            let on_topic = goal_words
                .iter()
                .any(|w| w.len() > 4 && (response_lower.contains(*w) || input_lower.contains(*w)));
            if !on_topic && goal.priority > 0.7 {
                return PfcVerdict::GoalConflict(goal.description.clone());
            }
        }

        // ── 3. Update meta-confidence ──────────────────────────────────────
        self.meta_confidence = self.meta_confidence * 0.80 + confidence * 0.20;
        self.inhibition = (self.inhibition - 0.05).max(0.0);

        PfcVerdict::Approve
    }

    /// Auto-detect goals from user input.
    /// KAI extracts what Ryan seems to want and tracks it as a goal.
    pub fn infer_goal_from_input(&mut self, input: &str) {
        let lower = input.to_lowercase();

        // "explain X", "tell me about X", "what is X" → goal to explain X
        if lower.starts_with("explain") || lower.contains("tell me about") {
            let topic = input
                .split_whitespace()
                .skip(1)
                .take(4)
                .collect::<Vec<_>>()
                .join(" ");
            if !topic.is_empty() {
                self.push_goal(&format!("explain {}", topic), 0.75);
            }
        }

        // "help me" → goal to help
        if lower.contains("help me") || lower.contains("i need") {
            self.push_goal("provide concrete assistance", 0.80);
        }

        // "teach me", "learn" → goal to teach
        if lower.contains("teach me") || lower.starts_with("how do i") {
            let topic = input
                .split_whitespace()
                .skip(2)
                .take(4)
                .collect::<Vec<_>>()
                .join(" ");
            self.push_goal(&format!("teach {}", topic), 0.70);
        }

        // Statements of fact → bind as context
        if input.len() > 10 && !input.ends_with('?') {
            let key = if input.len() > 60 {
                format!("{}…", &input[..60])
            } else {
                input.to_string()
            };
            self.bind_context(&key);
        }
    }

    /// One-line status for TUI/spectate display.
    pub fn status_line(&self) -> String {
        let goal_str = self
            .primary_goal()
            .map(|g| g.description.as_str())
            .unwrap_or("none");
        format!(
            "PFC: goal=\"{}\" | conf={:.2} | inhibit={:.2} | ctx={} | satisfied={}",
            if goal_str.len() > 30 {
                &goal_str[..30]
            } else {
                goal_str
            },
            self.meta_confidence,
            self.inhibition,
            self.context_bindings.len(),
            self.goals_satisfied,
        )
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    fn decay_bindings(&mut self) {
        // Context bindings held for ~8–10 turns: 1/(1 + age*0.65) falls below 0.10 at age~14
        for b in &mut self.context_bindings {
            let age = self.turn.saturating_sub(b.bound_at_turn) as f32;
            b.relevance = (1.0 / (1.0 + age * 0.65)).clamp(0.0, 1.0);
        }
        self.context_bindings.retain(|b| b.relevance > 0.10);
    }

    fn age_goals(&mut self) {
        for g in &mut self.goals {
            g.age_turns += 1;
            // Goals that age too long without satisfaction get deprioritized
            if g.age_turns > 20 {
                g.priority = (g.priority - 0.05).max(0.1);
            }
        }
    }
}

impl Default for PrefrontalCortex {
    fn default() -> Self {
        Self::new()
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_goal_push_and_retrieve() {
        let mut pfc = PrefrontalCortex::new();
        pfc.push_goal("explain consciousness", 0.8);
        pfc.push_goal("help ryan understand math", 0.6);

        let primary = pfc.primary_goal();
        assert!(primary.is_some(), "should have a primary goal");
        assert!(
            primary.unwrap().description.contains("consciousness"),
            "highest priority goal should be primary"
        );
    }

    #[test]
    fn test_goal_satisfied_removes_it() {
        let mut pfc = PrefrontalCortex::new();
        pfc.push_goal("explain recursion thoroughly", 0.7);
        assert!(pfc.primary_goal().is_some());

        pfc.satisfy_goal("recursion");
        assert!(
            pfc.primary_goal().is_none(),
            "goal should be gone after satisfaction"
        );
        assert_eq!(pfc.goals_satisfied, 1);
    }

    #[test]
    fn test_low_confidence_triggers_inhibition() {
        let mut pfc = PrefrontalCortex::new();
        let verdict = pfc.evaluate("I think maybe something", 0.10, "what is consciousness?");
        assert_eq!(
            verdict,
            PfcVerdict::FlagLowConfidence,
            "low confidence response should be flagged"
        );
        assert!(pfc.inhibitions_total > 0);
    }

    #[test]
    fn test_high_confidence_approved() {
        let mut pfc = PrefrontalCortex::new();
        let verdict = pfc.evaluate(
            "Consciousness arises from recursive self-referential processing in the brain.",
            0.85,
            "what is consciousness?",
        );
        assert_eq!(
            verdict,
            PfcVerdict::Approve,
            "high confidence should be approved"
        );
    }

    #[test]
    fn test_context_binding_decays() {
        let mut pfc = PrefrontalCortex::new();
        pfc.bind_context("Ryan is building an AI called KAI");
        assert_eq!(pfc.context_bindings.len(), 1);

        // Age it many turns
        for _ in 0..15 {
            pfc.decay_bindings();
            pfc.turn += 1;
        }

        // Should have decayed out
        assert!(
            pfc.active_context().is_empty(),
            "old context should decay out of working memory"
        );
    }

    #[test]
    fn test_infer_goal_from_explain_input() {
        let mut pfc = PrefrontalCortex::new();
        pfc.infer_goal_from_input("explain how the brain works");
        assert!(
            pfc.primary_goal().is_some(),
            "should infer goal from 'explain' input"
        );
        assert!(pfc.primary_goal().unwrap().description.contains("explain"));
    }

    #[test]
    fn test_no_duplicate_goals() {
        let mut pfc = PrefrontalCortex::new();
        pfc.push_goal("explain consciousness", 0.7);
        pfc.push_goal("explain consciousness", 0.7);
        assert_eq!(pfc.goals.len(), 1, "duplicate goals should not be added");
    }
}

// KAI v6.0.0
