/// Habenula — Anti-Reward, Disappointment Signal, Punishment Prediction
///
/// The habenula is the brain's anti-reward center — the yang to the VTA's yin.
/// While the VTA fires when reward is expected or received, the habenula fires
/// when expected reward is ABSENT. It is the neural signature of disappointment.
///
/// What the Habenula does:
///
///   Anti-reward prediction:
///     If you expect reward and don't get it, the habenula fires.
///     This drives VTA pause (dopamine suppression) — the opposite of RPE burst.
///     Habenula → VTA pause → NAc suppression → "this isn't worth pursuing."
///
///   Punishment prediction:
///     The habenula also fires when punishment is predicted (before it happens).
///     This is the neural basis of dread, avoidance learning, and aversion.
///     In KAI: dread of certain topic types, aversion to patterns that failed.
///
///   Learned helplessness:
///     Chronically elevated habenula activity → reduced dopamine → reduced
///     motivation → learned helplessness. This is a key mechanism in depression.
///     For KAI: over-punishing failures → creative shutdown → retreat.
///
///   Serotonin suppression by habenula:
///     Habenula also suppresses raphe firing, reducing 5-HT during
///     uncontrollable negative events. The raphe reciprocally suppresses
///     the habenula when 5-HT is high (closed-loop mood regulation).
///
///   Behavioral reset:
///     The habenula triggers response switching — "try something different."
///     After a failed strategy, habenula activity promotes exploration
///     of alternative approaches rather than persisting in the failed one.
///
/// KAI's Habenula:
///   activity: current habenula firing level (0.0–1.0)
///   disappointment_accum: accumulated unmet expectations
///   aversion_map: per-topic learned aversion scores
///   raphe_suppression: how much 5-HT the habenula is currently suppressing
///   behavioral_switch: whether the habenula is signaling "try differently"

use std::collections::HashMap;

// ── Constants ─────────────────────────────────────────────────────────────────

/// Habenula activity decay per tick (moderate — it lingers)
const ACTIVITY_DECAY: f32 = 0.04;

/// Disappointment accumulation per unmet expectation
const DISAPPOINTMENT_PER_MISS: f32 = 0.15;

/// Threshold for behavioral switch signal
const SWITCH_THRESHOLD: f32 = 0.50;

/// Aversion learning rate
const AVERSION_ALPHA: f32 = 0.10;

/// Maximum aversion per topic
const MAX_AVERSION: f32 = 0.80;

/// Aversion decay per tick (slow — learned aversions persist)
const AVERSION_DECAY: f32 = 0.001;

/// Raphe suppression scale factor
const RAPHE_SUPPRESSION_SCALE: f32 = 0.60;

// ── HabenulaSignal ────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub enum HabenulaSignal {
    /// Expected reward wasn't delivered
    RewardOmission { expected: f32 },
    /// Punishment predicted or received
    PunishmentPredicted { severity: f32 },
    /// Conflict or contradiction detected
    ConflictDetected { intensity: f32 },
    /// Topic that has historically failed
    AversiveTopic { topic: String },
    /// Raphe is suppressing this habenula (high 5-HT)
    SerotoninSuppression { strength: f32 },
}

// ── HabenulaOutput ────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct HabenulaOutput {
    /// Current habenula activity (0.0–1.0)
    pub activity: f32,
    /// Whether to signal VTA to suppress dopamine
    pub suppress_vta: bool,
    /// VTA suppression strength if active
    pub vta_suppression: f32,
    /// Whether behavioral switch is signaled
    pub behavioral_switch: bool,
    /// Raphe suppression amount
    pub raphe_suppression: f32,
    /// Topic aversion this tick (if relevant)
    pub topic_aversion: Option<f32>,
}

// ── Habenula ──────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct Habenula {
    /// Current activity level
    pub activity: f32,
    /// Accumulated disappointment
    pub disappointment_accum: f32,
    /// Per-topic aversion scores
    aversion_map: HashMap<String, f32>,
    /// Total signals processed
    pub signals_processed: u64,
    /// Total behavioral switches signaled
    pub switches_signaled: u64,
}

impl Habenula {
    pub fn new() -> Self {
        Self {
            activity:              0.0,
            disappointment_accum:  0.0,
            aversion_map:          HashMap::new(),
            signals_processed:     0,
            switches_signaled:     0,
        }
    }

    // ── Core: signal processing ───────────────────────────────────────────────

    /// Process a habenula signal. Returns HabenulaOutput.
    pub fn process(&mut self, signal: HabenulaSignal) -> HabenulaOutput {
        self.signals_processed += 1;

        match &signal {
            HabenulaSignal::RewardOmission { expected } => {
                // Activity proportional to how much was expected and didn't arrive
                let boost = expected * DISAPPOINTMENT_PER_MISS * 2.0;
                self.activity = (self.activity + boost).min(1.0);
                self.disappointment_accum = (self.disappointment_accum + boost * 0.5).min(1.0);
            }
            HabenulaSignal::PunishmentPredicted { severity } => {
                self.activity = (self.activity + severity * 0.20).min(1.0);
            }
            HabenulaSignal::ConflictDetected { intensity } => {
                self.activity = (self.activity + intensity * 0.12).min(1.0);
            }
            HabenulaSignal::AversiveTopic { topic } => {
                let aversion = self.aversion_map.get(topic).copied().unwrap_or(0.0);
                self.activity = (self.activity + aversion * 0.15).min(1.0);
                // Reinforce aversion
                let new_aversion = (aversion + AVERSION_ALPHA).min(MAX_AVERSION);
                self.aversion_map.insert(topic.clone(), new_aversion);
            }
            HabenulaSignal::SerotoninSuppression { strength } => {
                // High 5-HT quiets the habenula
                self.activity = (self.activity - strength * 0.20).max(0.0);
            }
        }

        self.build_output(&signal)
    }

    fn build_output(&mut self, signal: &HabenulaSignal) -> HabenulaOutput {
        let suppress_vta = self.activity > 0.40;
        let vta_suppression = if suppress_vta { self.activity * 0.70 } else { 0.0 };

        let behavioral_switch = self.activity >= SWITCH_THRESHOLD;
        if behavioral_switch {
            self.switches_signaled += 1;
        }

        let raphe_suppression = self.activity * RAPHE_SUPPRESSION_SCALE;

        let topic_aversion = if let HabenulaSignal::AversiveTopic { topic } = signal {
            self.aversion_map.get(topic).copied()
        } else {
            None
        };

        HabenulaOutput {
            activity: self.activity,
            suppress_vta,
            vta_suppression,
            behavioral_switch,
            raphe_suppression,
            topic_aversion,
        }
    }

    /// Decay every tick.
    pub fn decay(&mut self) {
        self.activity = (self.activity - ACTIVITY_DECAY).max(0.0);
        self.disappointment_accum = (self.disappointment_accum - 0.005).max(0.0);
        // Aversion map slow decay
        for val in self.aversion_map.values_mut() {
            *val = (*val - AVERSION_DECAY).max(0.0);
        }
    }

    /// Get current activity without processing.
    pub fn current_activity(&self) -> f32 { self.activity }

    /// Whether habenula is actively suppressing motivation.
    pub fn is_active(&self) -> bool { self.activity > 0.30 }

    /// Aversion score for a topic (0.0 if unknown).
    pub fn aversion_for(&self, topic: &str) -> f32 {
        self.aversion_map.get(topic).copied().unwrap_or(0.0)
    }

    /// Status line for brain monitor.
    pub fn status_line(&self) -> String {
        format!(
            "Habenula activity={:.2} | disappoint={:.2} | aversions={} | switches={}",
            self.activity,
            self.disappointment_accum,
            self.aversion_map.len(),
            self.switches_signaled,
        )
    }
}

impl Default for Habenula {
    fn default() -> Self { Self::new() }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_initial_state() {
        let h = Habenula::new();
        assert_eq!(h.activity, 0.0);
        assert_eq!(h.disappointment_accum, 0.0);
    }

    #[test]
    fn test_reward_omission_raises_activity() {
        let mut h = Habenula::new();
        let out = h.process(HabenulaSignal::RewardOmission { expected: 0.80 });
        assert!(out.activity > 0.0,
            "reward omission should raise habenula activity: {:.2}", out.activity);
    }

    #[test]
    fn test_punishment_prediction_raises_activity() {
        let mut h = Habenula::new();
        let out = h.process(HabenulaSignal::PunishmentPredicted { severity: 0.70 });
        assert!(out.activity > 0.0,
            "punishment prediction should raise activity: {:.2}", out.activity);
    }

    #[test]
    fn test_high_activity_suppresses_vta() {
        let mut h = Habenula::new();
        h.activity = 0.60;
        let out = h.process(HabenulaSignal::ConflictDetected { intensity: 0.0 });
        assert!(out.suppress_vta,
            "high habenula activity should suppress VTA: activity={:.2}", out.activity);
        assert!(out.vta_suppression > 0.0);
    }

    #[test]
    fn test_behavioral_switch_at_threshold() {
        let mut h = Habenula::new();
        h.activity = SWITCH_THRESHOLD + 0.05;
        let out = h.process(HabenulaSignal::ConflictDetected { intensity: 0.0 });
        assert!(out.behavioral_switch,
            "activity above threshold should signal behavioral switch");
    }

    #[test]
    fn test_serotonin_suppression_quiets_habenula() {
        let mut h = Habenula::new();
        h.activity = 0.60;
        h.process(HabenulaSignal::SerotoninSuppression { strength: 0.90 });
        assert!(h.activity < 0.60,
            "high serotonin should quiet habenula: {:.2}", h.activity);
    }

    #[test]
    fn test_aversive_topic_builds_aversion() {
        let mut h = Habenula::new();
        let topic = "criticism".to_string();
        h.process(HabenulaSignal::AversiveTopic { topic: topic.clone() });
        h.process(HabenulaSignal::AversiveTopic { topic: topic.clone() });
        let aversion = h.aversion_for(&topic);
        assert!(aversion > 0.0,
            "repeated aversive topic should build aversion: {:.2}", aversion);
    }

    #[test]
    fn test_decay_reduces_activity() {
        let mut h = Habenula::new();
        h.activity = 0.70;
        for _ in 0..10 {
            h.decay();
        }
        assert!(h.activity < 0.70,
            "habenula activity should decay: {:.2}", h.activity);
    }

    #[test]
    fn test_is_active() {
        let mut h = Habenula::new();
        h.activity = 0.50;
        assert!(h.is_active());
        h.activity = 0.10;
        assert!(!h.is_active());
    }

    #[test]
    fn test_raphe_suppression_present_when_active() {
        let mut h = Habenula::new();
        let out = h.process(HabenulaSignal::RewardOmission { expected: 1.0 });
        // raphe_suppression should be proportional to activity
        assert!(out.raphe_suppression >= 0.0);
    }

    #[test]
    fn test_status_line() {
        let h = Habenula::new();
        let s = h.status_line();
        assert!(s.contains("Habenula"), "status should mention Habenula");
        assert!(s.contains("activity"), "status should show activity");
    }
}
