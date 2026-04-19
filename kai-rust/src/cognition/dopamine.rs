/// Dopamine Reward Circuit — KAI's reinforcement learning engine
///
/// Dopamine is the brain's "learning signal" — not just pleasure, but
/// specifically the signal that says "that was better/worse than expected."
///
/// The key insight (Schultz et al., 1997): dopamine neurons fire not when
/// something good happens, but when something BETTER THAN EXPECTED happens.
/// This is called the Reward Prediction Error (RPE):
///
///   RPE > 0: outcome better than predicted → dopamine spike → learn "do more of that"
///   RPE = 0: outcome exactly as predicted → no signal → no learning
///   RPE < 0: outcome worse than predicted → dopamine dip → "avoid that"
///
/// This is why the brain constantly predicts — because the DIFFERENCE between
/// prediction and reality is what drives all learning. It's identical to the
/// error signal in modern machine learning (TD-learning, Q-learning).
///
/// Without dopamine:
///   Every interaction is treated equally. KAI doesn't learn what kinds
///   of questions he's good at vs. bad at. He doesn't build expertise over
///   time. He doesn't get "interested" in topics he handles well.
///   There is no reinforcement — just flat pattern matching.
///
/// With dopamine:
///   When KAI answers well (high confidence, user seems engaged), a dopamine
///   spike reinforces that topic's patterns in the universe.
///   When KAI answers poorly (low confidence, contradiction flagged), a dip
///   weakens those patterns slightly.
///   Over many interactions, KAI becomes genuinely better at topics he's
///   practiced and naturally gravitates toward them (expertise formation).
///
/// Architecture:
///   DopamineCircuit tracks:
///     - Current dopamine level (0–1, decays to baseline 0.5)
///     - Reward Prediction Error per interaction
///     - Topic-specific reward history (which topics yield positive RPE)
///     - Streak tracking (consecutive good answers = dopamine momentum)
///     - Drive modulation output: high dopamine → KAI is engaged and curious

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Constants ─────────────────────────────────────────────────────────────────

/// Baseline dopamine level (resting state)
const BASELINE: f32 = 0.50;

/// Decay rate per tick back toward baseline
const DECAY: f32 = 0.015;

/// Max dopamine level
const MAX_DOPAMINE: f32 = 1.0;

/// Min dopamine level (floor — can't go to zero, brain still runs)
const MIN_DOPAMINE: f32 = 0.10;

/// Maximum topics to track reward history for
const MAX_TOPIC_HISTORY: usize = 128;

// ── Dopamine Event ────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DopamineEvent {
    /// Topic that triggered this event
    pub topic: String,
    /// Reward Prediction Error: positive = better than expected, negative = worse
    pub rpe: f32,
    /// Resulting dopamine level after this event
    pub level: f32,
}

// ── Dopamine Circuit ──────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DopamineCircuit {
    /// Current dopamine level (0.1–1.0, baseline 0.5)
    pub level: f32,
    /// Smoothed average — the "tonic" dopamine baseline
    pub tonic: f32,
    /// Per-topic reward scores (positive = rewarding, negative = aversive)
    topic_rewards: HashMap<String, f32>,
    /// Consecutive positive RPE streak (dopamine momentum)
    pub streak: u32,
    /// Total reward events
    pub total_events: u64,
    /// Total positive events (RPE > 0)
    pub positive_events: u64,
    /// Whether KAI is currently in a "flow" state (sustained high dopamine)
    pub in_flow: bool,
    /// Tick counter for decay
    ticks: u64,
}

impl DopamineCircuit {
    pub fn new() -> Self {
        Self {
            level:           BASELINE,
            tonic:           BASELINE,
            topic_rewards:   HashMap::new(),
            streak:          0,
            total_events:    0,
            positive_events: 0,
            in_flow:         false,
            ticks:           0,
        }
    }

    /// Fire the reward circuit based on an interaction outcome.
    ///
    /// - `topic`      — the main topic of the interaction
    /// - `confidence` — how confident KAI was (0–1)
    /// - `expected`   — what KAI predicted (from predictor.avg_error context)
    ///
    /// Returns the RPE for this event (positive = good, negative = bad).
    pub fn fire(
        &mut self,
        topic:      &str,
        confidence: f32,
        expected:   f32,   // prior expected confidence (from predictor)
    ) -> f32 {
        // RPE = actual outcome - expected outcome
        // Positive: did better than expected → dopamine spike
        // Negative: did worse than expected → dopamine dip
        let rpe = (confidence - expected).clamp(-0.8, 0.8);

        // Update dopamine level
        let delta = rpe * 0.35;
        self.level = (self.level + delta).clamp(MIN_DOPAMINE, MAX_DOPAMINE);

        // Update tonic (slow-moving average — the "mood baseline")
        self.tonic = self.tonic * 0.97 + self.level * 0.03;

        // Update topic reward history
        let topic_key = extract_topic_key(topic);
        let entry = self.topic_rewards.entry(topic_key).or_insert(0.0);
        *entry = (*entry * 0.85 + rpe * 0.15).clamp(-1.0, 1.0);

        // Prune topic history if too large
        if self.topic_rewards.len() > MAX_TOPIC_HISTORY {
            // Remove the least rewarding topic
            if let Some(worst_key) = self.topic_rewards.iter()
                .min_by(|a, b| a.1.partial_cmp(b.1).unwrap())
                .map(|(k, _)| k.clone())
            {
                self.topic_rewards.remove(&worst_key);
            }
        }

        // Streak tracking
        if rpe > 0.05 {
            self.streak += 1;
            self.positive_events += 1;
        } else if rpe < -0.05 {
            self.streak = 0;
        }

        // Flow state: sustained high dopamine + streak
        self.in_flow = self.level > 0.72 && self.streak >= 3;

        self.total_events += 1;
        rpe
    }

    /// Decay dopamine back toward tonic baseline each tick.
    /// Call once per heartbeat.
    pub fn decay(&mut self) {
        self.ticks += 1;
        // Exponential decay toward tonic
        self.level = self.level + (self.tonic - self.level) * DECAY;
        self.level = self.level.clamp(MIN_DOPAMINE, MAX_DOPAMINE);

        // Flow state decays if dopamine drops
        if self.level < 0.60 { self.in_flow = false; }
    }

    /// How rewarding does KAI find a given topic? (−1 = aversive, +1 = rewarding)
    pub fn topic_reward(&self, topic: &str) -> f32 {
        let key = extract_topic_key(topic);
        self.topic_rewards.get(&key).copied().unwrap_or(0.0)
    }

    /// The top N most rewarding topics KAI has encountered.
    pub fn top_topics(&self, n: usize) -> Vec<(String, f32)> {
        let mut topics: Vec<(String, f32)> = self.topic_rewards.clone().into_iter().collect();
        topics.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        topics.into_iter().take(n).collect()
    }

    /// Modulation output: how much dopamine boosts curiosity/engagement.
    /// Returns a multiplier (1.0 = neutral, >1.0 = boosted, <1.0 = dampened).
    pub fn engagement_multiplier(&self) -> f32 {
        // High dopamine → KAI is more engaged, explores more
        // Low dopamine → KAI is flat, less curious
        0.5 + self.level
    }

    /// True if KAI is in a "flow" state — sustained high-performance engagement.
    pub fn is_in_flow(&self) -> bool { self.in_flow }

    /// True if dopamine is below tonic — KAI is in a "dip" state.
    pub fn is_in_dip(&self) -> bool { self.level < self.tonic - 0.10 }

    /// Normalized dopamine deviation from tonic (−1 to +1).
    /// Positive = above baseline (excited), negative = below (flat/disappointed).
    pub fn deviation(&self) -> f32 {
        (self.level - self.tonic).clamp(-1.0, 1.0)
    }

    /// One-line status for TUI/spectate.
    pub fn status_line(&self) -> String {
        let state = if self.in_flow { "FLOW" }
                    else if self.is_in_dip() { "dip" }
                    else { "stable" };
        format!(
            "DA: {:.3} | tonic={:.3} | streak={} | state={} | +events={}",
            self.level, self.tonic, self.streak, state, self.positive_events
        )
    }
}

impl Default for DopamineCircuit {
    fn default() -> Self { Self::new() }
}

/// Extract a normalized topic key (first 2 meaningful words of a text).
fn extract_topic_key(text: &str) -> String {
    let stop = ["the", "a", "an", "is", "are", "was", "i", "you", "it",
                "this", "that", "for", "of", "to", "in", "on", "and"];
    text.split_whitespace()
        .map(|w| w.to_lowercase())
        .map(|w| w.trim_matches(|c: char| !c.is_alphabetic()).to_string())
        .filter(|w| w.len() >= 4 && !stop.contains(&w.as_str()))
        .take(2)
        .collect::<Vec<_>>()
        .join("_")
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_positive_rpe_raises_dopamine() {
        let mut da = DopamineCircuit::new();
        let before = da.level;
        da.fire("consciousness", 0.85, 0.40); // much better than expected
        assert!(da.level > before, "positive RPE should raise dopamine: {:.3} -> {:.3}", before, da.level);
    }

    #[test]
    fn test_negative_rpe_lowers_dopamine() {
        let mut da = DopamineCircuit::new();
        let before = da.level;
        da.fire("calculus", 0.10, 0.70); // much worse than expected
        assert!(da.level < before, "negative RPE should lower dopamine: {:.3} -> {:.3}", before, da.level);
    }

    #[test]
    fn test_flow_state_on_streak() {
        let mut da = DopamineCircuit::new();
        assert!(!da.in_flow, "should not start in flow");
        // Three consecutive very positive events
        for _ in 0..5 {
            da.fire("geometry", 0.90, 0.40);
        }
        assert!(da.in_flow, "should enter flow after sustained positive RPE");
        assert!(da.streak >= 3, "streak should be >= 3: {}", da.streak);
    }

    #[test]
    fn test_decay_returns_to_tonic() {
        let mut da = DopamineCircuit::new();
        da.fire("shock", 0.95, 0.10); // huge spike
        let after_spike = da.level;
        for _ in 0..200 { da.decay(); }
        assert!(da.level < after_spike,
            "dopamine should decay back toward tonic: {:.3} -> {:.3}", after_spike, da.level);
        assert!((da.level - da.tonic).abs() < 0.10,
            "should be near tonic after 200 ticks: level={:.3} tonic={:.3}", da.level, da.tonic);
    }

    #[test]
    fn test_topic_reward_tracking() {
        let mut da = DopamineCircuit::new();
        // Repeatedly succeed at geometry
        for _ in 0..5 { da.fire("geometry is beautiful", 0.85, 0.50); }
        let geom_reward = da.topic_reward("geometry is beautiful");
        assert!(geom_reward > 0.0, "repeated success should make topic rewarding: {:.3}", geom_reward);

        // Fail repeatedly at something else
        for _ in 0..5 { da.fire("tax forms and legal docs", 0.05, 0.50); }
        let tax_reward = da.topic_reward("tax forms and legal docs");
        assert!(tax_reward < 0.0, "repeated failure should make topic aversive: {:.3}", tax_reward);
    }

    #[test]
    fn test_dopamine_bounds() {
        let mut da = DopamineCircuit::new();
        for _ in 0..20 { da.fire("topic", 1.0, 0.0); } // max positive
        assert!(da.level <= MAX_DOPAMINE, "dopamine should not exceed max");
        for _ in 0..20 { da.fire("topic", 0.0, 1.0); } // max negative
        assert!(da.level >= MIN_DOPAMINE, "dopamine should not go below min");
    }

    #[test]
    fn test_engagement_multiplier_above_one_when_high_da() {
        let mut da = DopamineCircuit::new();
        da.fire("amazing insight", 0.95, 0.30);
        assert!(da.engagement_multiplier() > 1.0,
            "high dopamine should boost engagement multiplier: {:.3}", da.engagement_multiplier());
    }
}
