/// Basal Ganglia — KAI's habit formation and action selection engine
///
/// The basal ganglia are a cluster of nuclei deep in the brain that
/// most people associate with Parkinson's disease (when they fail)
/// but almost never think about when working correctly. They are the
/// brain's action selection system — the gatekeeper between "thinking
/// about doing something" and "actually doing it."
///
/// Three key mechanisms:
///
///   ACTION SELECTION (Go/NoGo pathways)
///   The basal ganglia run two competing channels simultaneously:
///   - "Go" pathway: releases inhibition → allows an action
///   - "NoGo" pathway: increases inhibition → suppresses an action
///   At any moment, the balance of Go vs. NoGo determines whether
///   an action gets executed or stays suppressed.
///   For KAI: controls whether a candidate response "goes through"
///   or gets inhibited. High-utility patterns get the Go signal.
///   Risky or low-quality patterns get suppressed.
///
///   HABIT FORMATION (striatal reinforcement)
///   The striatum (part of basal ganglia) learns which actions in
///   which contexts lead to reward. Over thousands of repetitions,
///   a behavior that was once deliberate (needs PFC attention)
///   becomes a habit (runs automatically on a trigger).
///   For KAI: tracks which response patterns (by type and context)
///   have historically been rewarded. High-reward patterns become
///   habitual — they fire faster and with less "effort".
///
///   DOPAMINE GATE (reward contingency)
///   The basal ganglia are drenched in dopamine receptors.
///   Dopamine controls learning: high dopamine = strengthen the
///   currently active action. Low dopamine = let connections weaken.
///   This is why dopamine depletion (Parkinson's) causes movement
///   difficulty — the Go pathway can't be reinforced.
///   For KAI: dopamine level gates how much habit learning happens.
///   A rewarding exchange (high dopamine) burns the response pattern
///   deeper into the habit bank. A poor exchange weakens it.
///
/// Architecture for KAI:
///   BasalGanglia tracks:
///     - habit_bank: learned utility scores per (context_type, response_type)
///     - go_threshold: the current minimum utility needed to execute
///     - go_signal: sum of Go activations this cycle
///     - nogo_signal: sum of NoGo activations this cycle
///     - action_count: total actions executed
///     - suppressed_count: total actions suppressed (NoGo won)
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Constants ─────────────────────────────────────────────────────────────────

/// Minimum utility score for Go pathway to win
const GO_THRESHOLD: f32 = 0.35;

/// Learning rate for habit reinforcement (per dopamine event)
const HABIT_ALPHA: f32 = 0.05;

/// How quickly habit strengths decay (disuse = weakening)
const HABIT_DECAY: f32 = 0.0008;

/// Maximum habit utility (ceiling)
const MAX_HABIT: f32 = 2.0;

/// Minimum habit utility before pruning
const MIN_HABIT: f32 = 0.05;

// ── Action Decision ───────────────────────────────────────────────────────────

/// The result of running the Go/NoGo gate.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum ActionDecision {
    /// Go pathway won — execute this response pattern
    Go { utility: f32 },
    /// NoGo pathway won — suppress this response pattern
    NoGo { reason: String },
}

impl ActionDecision {
    pub fn is_go(&self) -> bool {
        matches!(self, ActionDecision::Go { .. })
    }
    pub fn utility(&self) -> f32 {
        match self {
            ActionDecision::Go { utility } => *utility,
            ActionDecision::NoGo { .. } => 0.0,
        }
    }
}

// ── Basal Ganglia ─────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BasalGanglia {
    /// Learned utility per pattern key ("context:response_type")
    habit_bank: HashMap<String, f32>,
    /// Current Go/NoGo threshold — adapts with experience
    pub go_threshold: f32,
    /// Total Go signals fired (actions executed)
    pub action_count: u64,
    /// Total NoGo signals fired (actions suppressed)
    pub suppressed_count: u64,
    /// Total habit reinforcement events
    pub reinforcement_count: u64,
    /// Running average of utility for recently executed actions
    pub avg_utility: f32,
}

impl BasalGanglia {
    pub fn new() -> Self {
        Self {
            habit_bank: HashMap::new(),
            go_threshold: GO_THRESHOLD,
            action_count: 0,
            suppressed_count: 0,
            reinforcement_count: 0,
            avg_utility: 0.50,
        }
    }

    /// Evaluate whether a response pattern should be executed (Go) or suppressed (NoGo).
    ///
    /// Args:
    ///   - `context_type`:    what kind of input this is ("question", "statement", "command")
    ///   - `response_type`:   what KAI plans to do ("explain", "ask_back", "recall", "store")
    ///   - `raw_confidence`:  KAI's raw confidence in this response (0–1)
    ///   - `dopamine_level`:  current dopamine (modulates Go/NoGo balance)
    ///
    /// Returns ActionDecision::Go or ActionDecision::NoGo.
    pub fn evaluate(
        &mut self,
        context_type: &str,
        response_type: &str,
        raw_confidence: f32,
        dopamine_level: f32,
    ) -> ActionDecision {
        let key = habit_key(context_type, response_type);
        let habit_util = self.habit_bank.get(&key).copied().unwrap_or(0.50);

        // Go signal = raw_confidence × habit_utility × dopamine_boost
        let da_boost = 0.7 + dopamine_level * 0.6;
        let go_signal = (raw_confidence * habit_util * da_boost).min(2.0);

        // NoGo signal = inverse confidence × inverse habit (unfamiliar + low confidence)
        let nogo_signal = (1.0 - raw_confidence) * (1.0 / habit_util.max(0.1)).min(2.0) * 0.5;

        let effective_utility = go_signal - nogo_signal;

        if effective_utility >= self.go_threshold {
            self.action_count += 1;
            self.avg_utility = self.avg_utility * 0.92 + effective_utility * 0.08;
            ActionDecision::Go {
                utility: effective_utility,
            }
        } else {
            self.suppressed_count += 1;
            let reason = if raw_confidence < 0.25 {
                "confidence too low".to_string()
            } else if habit_util < 0.30 {
                "unfamiliar pattern".to_string()
            } else {
                "utility below threshold".to_string()
            };
            ActionDecision::NoGo { reason }
        }
    }

    /// Reinforce a response pattern after it was executed.
    ///
    /// Called after KAI gets a reward signal (dopamine fire, positive PE).
    /// High dopamine = strong reinforcement. Negative outcome = weakening.
    ///
    /// Args:
    ///   - `context_type`, `response_type`: the pattern being reinforced
    ///   - `reward`:   reward signal, +1.0 = very good, -1.0 = very bad
    ///   - `dopamine`: current dopamine level (gates learning rate)
    pub fn reinforce(
        &mut self,
        context_type: &str,
        response_type: &str,
        reward: f32,
        dopamine: f32,
    ) {
        let key = habit_key(context_type, response_type);
        let current = self.habit_bank.entry(key).or_insert(0.50);

        // Dopamine-gated Hebbian: reward × dopamine × alpha
        let delta = reward * dopamine * HABIT_ALPHA;
        *current = (*current + delta).clamp(MIN_HABIT, MAX_HABIT);

        self.reinforcement_count += 1;

        // Adapt go_threshold: if we're reinforcing often, expect higher utility
        // (sets a higher bar as habits improve)
        self.go_threshold = (self.avg_utility * 0.4 + GO_THRESHOLD * 0.6).clamp(0.20, 0.70);
    }

    /// Decay all habit utilities each tick (disuse → weakening).
    /// Called periodically from heartbeat.
    pub fn decay(&mut self) {
        let mut to_prune = Vec::new();
        for (key, util) in self.habit_bank.iter_mut() {
            *util -= HABIT_DECAY;
            if *util < MIN_HABIT {
                to_prune.push(key.clone());
            }
        }
        for key in to_prune {
            self.habit_bank.remove(&key);
        }
    }

    /// How many habits are currently tracked?
    pub fn habit_count(&self) -> usize {
        self.habit_bank.len()
    }

    /// Retrieve the utility of a specific pattern (0 if unknown).
    pub fn habit_utility(&self, context_type: &str, response_type: &str) -> f32 {
        self.habit_bank
            .get(&habit_key(context_type, response_type))
            .copied()
            .unwrap_or(0.50)
    }

    /// Go/NoGo ratio — >0.5 means KAI executes more than suppresses
    pub fn go_ratio(&self) -> f32 {
        let total = self.action_count + self.suppressed_count;
        if total == 0 {
            return 0.5;
        }
        self.action_count as f32 / total as f32
    }

    /// One-line status for TUI/spectate.
    pub fn status_line(&self) -> String {
        format!(
            "BG: habits={} go={}/{} ratio={:.2} avg_util={:.3} thr={:.3}",
            self.habit_bank.len(),
            self.action_count,
            self.suppressed_count,
            self.go_ratio(),
            self.avg_utility,
            self.go_threshold,
        )
    }
}

impl Default for BasalGanglia {
    fn default() -> Self {
        Self::new()
    }
}

fn habit_key(context: &str, response: &str) -> String {
    format!("{}:{}", context, response)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_high_confidence_gets_go() {
        let mut bg = BasalGanglia::new();
        let decision = bg.evaluate("question", "explain", 0.90, 0.80);
        assert!(
            decision.is_go(),
            "high confidence + high dopamine should get Go: {:?}",
            decision
        );
    }

    #[test]
    fn test_low_confidence_gets_nogo() {
        let mut bg = BasalGanglia::new();
        let decision = bg.evaluate("question", "explain", 0.05, 0.20);
        assert!(
            !decision.is_go(),
            "very low confidence should get NoGo: {:?}",
            decision
        );
    }

    #[test]
    fn test_reinforcement_increases_habit_utility() {
        let mut bg = BasalGanglia::new();
        let before = bg.habit_utility("question", "explain");
        // Reinforce with strong reward + high dopamine
        for _ in 0..10 {
            bg.reinforce("question", "explain", 1.0, 0.9);
        }
        let after = bg.habit_utility("question", "explain");
        assert!(
            after > before,
            "repeated reinforcement should increase utility: before={:.3} after={:.3}",
            before,
            after
        );
    }

    #[test]
    fn test_negative_reward_weakens_habit() {
        let mut bg = BasalGanglia::new();
        // First build up a habit
        for _ in 0..5 {
            bg.reinforce("statement", "recall", 1.0, 0.8);
        }
        let peak = bg.habit_utility("statement", "recall");
        // Then punish it
        for _ in 0..8 {
            bg.reinforce("statement", "recall", -1.0, 0.8);
        }
        let after = bg.habit_utility("statement", "recall");
        assert!(
            after < peak,
            "negative reward should weaken habit: peak={:.3} after={:.3}",
            peak,
            after
        );
    }

    #[test]
    fn test_decay_weakens_habits() {
        let mut bg = BasalGanglia::new();
        // Build a habit
        bg.reinforce("question", "ask_back", 1.0, 0.8);
        let before = bg.habit_utility("question", "ask_back");
        // Decay many times
        for _ in 0..500 {
            bg.decay();
        }
        let after = bg.habit_utility("question", "ask_back");
        // Either weakened significantly OR pruned entirely (0.50 default)
        assert!(
            after <= before,
            "decay should weaken or prune habit: before={:.3} after={:.3}",
            before,
            after
        );
    }

    #[test]
    fn test_go_ratio_tracks_decisions() {
        let mut bg = BasalGanglia::new();
        bg.evaluate("question", "explain", 0.9, 0.9); // Go
        bg.evaluate("question", "explain", 0.9, 0.9); // Go
        bg.evaluate("question", "explain", 0.02, 0.1); // NoGo
        let ratio = bg.go_ratio();
        assert!(
            ratio > 0.5,
            "2 Go + 1 NoGo → ratio should be > 0.5: {:.3}",
            ratio
        );
    }

    #[test]
    fn test_reinforced_pattern_more_likely_to_go() {
        // Without reinforcement: moderate confidence + dopamine → NoGo (habit is neutral/weak)
        let mut bg_fresh = BasalGanglia::new();
        let fresh = bg_fresh.evaluate("question", "explain", 0.55, 0.70);
        assert!(
            !fresh.is_go(),
            "fresh (no reinforcement) should NoGo on moderate confidence: {:?}",
            fresh
        );

        // After heavy reinforcement: same inputs should Go (habit utility lifts the signal)
        let mut bg = BasalGanglia::new();
        for _ in 0..15 {
            bg.reinforce("question", "explain", 1.0, 0.85);
        }
        let decision = bg.evaluate("question", "explain", 0.55, 0.70);
        assert!(
            decision.is_go(),
            "reinforced habit should push moderate confidence to Go: {:?}",
            decision
        );
    }
}

// KAI v6.0.0
