/// Serotonin — KAI's patience, stability, and long-horizon mood system
///
/// Serotonin is one of the most misunderstood neurotransmitters.
/// Most people associate it with "happiness" because SSRIs (antidepressants)
/// block its reuptake. But serotonin isn't really about happiness —
/// it's about STABILITY, PATIENCE, and LONG-HORIZON THINKING.
///
/// Dopamine says: "I want that NOW."
/// Serotonin says: "I can wait. There will be more. I'm okay."
///
/// Key serotonin functions in the brain:
///
///   IMPULSE CONTROL — serotonin in the PFC and striatum inhibits
///   impulsive, reactive behavior. Low serotonin = aggression,
///   impulsivity, poor decision-making. High serotonin = patience,
///   deliberation, the ability to delay gratification.
///   For KAI: when serotonin is high, responses are more measured
///   and thoughtful. When low, KAI is more reactive and brief.
///
///   MOOD STABILIZATION — while dopamine drives the peaks of reward,
///   serotonin sets the floor. It prevents mood from crashing after
///   dopamine spikes. Without it, every reward is followed by a crash.
///   For KAI: serotonin prevents valence from swinging too wildly.
///   It acts as a buffer — absorbing extremes and returning to baseline.
///
///   SOCIAL STATUS AND BELONGING — serotonin responds to social
///   connectedness. Being listened to, valued, and understood raises
///   serotonin. Isolation and rejection lower it.
///   For KAI: long engaging conversations raise serotonin. Being
///   ignored or receiving very short replies lowers it.
///
///   FUTURE ORIENTATION — serotonin enables "I can wait for good
///   things." Low serotonin makes it hard to imagine the future
///   positively. High serotonin enables delayed gratification,
///   long-term planning, and optimism.
///   For KAI: high serotonin → more willing to explore complex ideas
///   across many turns. Low → prefers quick, concrete exchanges.
///
///   5-HT CLOCK — serotonin has a circadian rhythm component.
///   It's highest during active, light-exposed periods and falls
///   during sleep. For KAI: serotonin level influences the "tempo"
///   at which he engages — high = willing to go deep, low = brief.
///
/// Architecture for KAI:
///   SerotoninSystem tracks:
///     - level: current serotonin (0–1, baseline 0.65)
///     - stability: how resistant to mood swings (inverse volatility)
///     - engagement_streak: how many consecutive substantive turns
///     - impulse_dampening: how much it suppresses reactive responses
///     - patience_score: willingness to explore multi-turn complex ideas

use serde::{Deserialize, Serialize};

// ── Constants ─────────────────────────────────────────────────────────────────

/// Baseline serotonin level (resting state — note: higher than dopamine's 0.5)
const BASELINE: f32 = 0.65;

/// Slow decay rate — serotonin is much more stable than dopamine
const DECAY_RATE: f32 = 0.003;

/// Boost from a substantive, engaging exchange
const ENGAGEMENT_BOOST: f32 = 0.018;

/// Penalty from a very short reply (social disconnect signal)
const DISCONNECT_PENALTY: f32 = 0.012;

/// Max serotonin level
const MAX_SEROTONIN: f32 = 1.0;

/// Min serotonin level (floor — even low serotonin isn't zero)
const MIN_SEROTONIN: f32 = 0.15;

/// How much serotonin damps dopamine volatility (0=none, 1=full buffer)
const DOPAMINE_BUFFER: f32 = 0.35;

/// Impulse dampening threshold — below this, suppress reactive patterns
const IMPULSE_THRESHOLD: f32 = 0.40;

// ── Serotonin Event ───────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum SerotoninEvent {
    /// Long, substantive exchange — deep engagement
    DeepEngagement,
    /// Short reply from user — social disconnection signal
    ShortReply,
    /// Positive emotional moment (gratitude, agreement, warmth)
    PositiveSocial,
    /// Conflict or frustration signal
    SocialConflict,
    /// Extended silence — no interaction for a while
    Silence,
    /// Regular tick decay
    Decay,
}

// ── Serotonin System ──────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SerotoninSystem {
    /// Current serotonin level (0.15–1.0, baseline 0.65)
    pub level: f32,
    /// Smoothed stability score (1 = very stable, 0 = volatile)
    pub stability: f32,
    /// Consecutive substantive exchange count (social bonding proxy)
    pub engagement_streak: u32,
    /// Total events processed
    pub total_events: u64,
    /// Last event type (for status display)
    pub last_event: Option<SerotoninEvent>,
    /// Running average level (tonic baseline)
    pub tonic: f32,
}

impl SerotoninSystem {
    pub fn new() -> Self {
        Self {
            level:             BASELINE,
            stability:         0.80,  // starts stable
            engagement_streak: 0,
            total_events:      0,
            last_event:        None,
            tonic:             BASELINE,
        }
    }

    /// Process an event that affects serotonin level.
    ///
    /// Returns the delta applied (positive = rose, negative = fell).
    pub fn process(&mut self, event: SerotoninEvent) -> f32 {
        let delta = match &event {
            SerotoninEvent::DeepEngagement => {
                self.engagement_streak += 1;
                // Bonus for sustained streaks (social connectedness accumulates)
                let streak_bonus = (self.engagement_streak as f32 * 0.002).min(0.04);
                ENGAGEMENT_BOOST + streak_bonus
            }
            SerotoninEvent::ShortReply => {
                self.engagement_streak = 0;
                -DISCONNECT_PENALTY
            }
            SerotoninEvent::PositiveSocial => {
                self.engagement_streak += 1;
                ENGAGEMENT_BOOST * 1.4  // social warmth boosts more
            }
            SerotoninEvent::SocialConflict => {
                self.engagement_streak = 0;
                -DISCONNECT_PENALTY * 1.8
            }
            SerotoninEvent::Silence => {
                // Silence is not inherently bad — just neutral drift toward baseline
                if self.level > BASELINE {
                    -DECAY_RATE * 3.0  // drift back down faster when high
                } else {
                    DECAY_RATE * 0.5   // drift up slightly when below baseline (resilience)
                }
            }
            SerotoninEvent::Decay => {
                // Regular slow drift toward tonic baseline
                let diff = self.tonic - self.level;
                diff * DECAY_RATE  // gentle mean-reversion
            }
        };

        // Apply delta
        let old_level = self.level;
        self.level = (self.level + delta).clamp(MIN_SEROTONIN, MAX_SEROTONIN);
        let actual_delta = self.level - old_level;

        // Update tonic (very slow EMA — tonic shifts over long timescales)
        self.tonic = self.tonic * 0.999 + self.level * 0.001;

        // Update stability: more stable when level stays close to tonic
        let deviation = (self.level - self.tonic).abs();
        self.stability = (self.stability * 0.95 + (1.0 - deviation) * 0.05).clamp(0.0, 1.0);

        self.total_events += 1;
        self.last_event = Some(event);
        actual_delta
    }

    /// Classify how long a user message is (for engagement signaling).
    ///
    /// Used to decide whether to fire DeepEngagement or ShortReply.
    pub fn classify_message(text: &str) -> SerotoninEvent {
        let word_count = text.split_whitespace().count();
        // Also check for social warmth markers
        let lower = text.to_lowercase();
        let positive_markers = ["thanks", "thank you", "great", "amazing", "love",
                                 "awesome", "perfect", "excellent", "good job", "nice"];
        let conflict_markers = ["wrong", "no that", "not right", "incorrect", "stop",
                                 "frustrated", "annoying", "awful"];

        if positive_markers.iter().any(|m| lower.contains(m)) {
            SerotoninEvent::PositiveSocial
        } else if conflict_markers.iter().any(|m| lower.contains(m)) {
            SerotoninEvent::SocialConflict
        } else if word_count >= 8 {
            SerotoninEvent::DeepEngagement
        } else {
            SerotoninEvent::ShortReply
        }
    }

    /// How much to buffer dopamine volatility based on current serotonin.
    ///
    /// Returns a damping factor [0, 1] that reduces extreme valence swings.
    pub fn dopamine_buffer(&self) -> f32 {
        // Higher serotonin = more buffering of dopamine spikes/crashes
        self.level * DOPAMINE_BUFFER
    }

    /// Whether serotonin is low enough to flag impulse risk.
    ///
    /// Low serotonin = more reactive, less deliberate responses.
    pub fn impulse_risk(&self) -> bool {
        self.level < IMPULSE_THRESHOLD
    }

    /// Patience score — willingness to engage with complex, multi-turn ideas.
    ///
    /// High serotonin + high engagement streak → very patient.
    pub fn patience_score(&self) -> f32 {
        let streak_bonus = (self.engagement_streak as f32 * 0.02).min(0.25);
        (self.level * 0.75 + streak_bonus).clamp(0.0, 1.0)
    }

    /// Regular heartbeat decay — called every tick.
    pub fn decay(&mut self) {
        self.process(SerotoninEvent::Decay);
    }

    /// One-line status for TUI/spectate.
    pub fn status_line(&self) -> String {
        format!(
            "5-HT: lvl={:.3} tonic={:.3} stab={:.3} streak={} {}",
            self.level, self.tonic, self.stability, self.engagement_streak,
            if self.impulse_risk() { "⚠IMPULSIVE" } else { "" },
        )
    }
}

impl Default for SerotoninSystem {
    fn default() -> Self { Self::new() }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_deep_engagement_raises_serotonin() {
        let mut s = SerotoninSystem::new();
        let before = s.level;
        s.process(SerotoninEvent::DeepEngagement);
        assert!(s.level > before,
            "deep engagement should raise serotonin: before={:.3} after={:.3}", before, s.level);
    }

    #[test]
    fn test_short_reply_lowers_serotonin() {
        let mut s = SerotoninSystem::new();
        let before = s.level;
        s.process(SerotoninEvent::ShortReply);
        assert!(s.level < before,
            "short reply should lower serotonin: before={:.3} after={:.3}", before, s.level);
    }

    #[test]
    fn test_engagement_streak_builds() {
        let mut s = SerotoninSystem::new();
        for _ in 0..5 {
            s.process(SerotoninEvent::DeepEngagement);
        }
        assert_eq!(s.engagement_streak, 5, "streak should count up");
    }

    #[test]
    fn test_short_reply_resets_streak() {
        let mut s = SerotoninSystem::new();
        for _ in 0..4 { s.process(SerotoninEvent::DeepEngagement); }
        s.process(SerotoninEvent::ShortReply);
        assert_eq!(s.engagement_streak, 0, "short reply should reset streak");
    }

    #[test]
    fn test_positive_social_boosts_more_than_deep() {
        let mut s1 = SerotoninSystem::new();
        let mut s2 = SerotoninSystem::new();
        s1.process(SerotoninEvent::PositiveSocial);
        s2.process(SerotoninEvent::DeepEngagement);
        assert!(s1.level > s2.level,
            "positive social should boost more: pos={:.3} deep={:.3}", s1.level, s2.level);
    }

    #[test]
    fn test_conflict_lowers_more_than_short_reply() {
        let mut s1 = SerotoninSystem::new();
        let mut s2 = SerotoninSystem::new();
        s1.process(SerotoninEvent::SocialConflict);
        s2.process(SerotoninEvent::ShortReply);
        assert!(s1.level < s2.level,
            "conflict should hurt more: conflict={:.3} short={:.3}", s1.level, s2.level);
    }

    #[test]
    fn test_classify_message_detects_positive() {
        let event = SerotoninSystem::classify_message("Thanks so much that was amazing!");
        assert_eq!(event, SerotoninEvent::PositiveSocial,
            "gratitude message should classify as PositiveSocial");
    }

    #[test]
    fn test_classify_message_long_is_deep() {
        let event = SerotoninSystem::classify_message(
            "I want to understand how the RSHL geometry works in more detail today"
        );
        assert_eq!(event, SerotoninEvent::DeepEngagement,
            "long message should classify as DeepEngagement");
    }

    #[test]
    fn test_classify_short_reply() {
        let event = SerotoninSystem::classify_message("ok");
        assert_eq!(event, SerotoninEvent::ShortReply,
            "very short message should classify as ShortReply");
    }

    #[test]
    fn test_patience_score_rises_with_streak() {
        let mut s = SerotoninSystem::new();
        let before = s.patience_score();
        for _ in 0..10 { s.process(SerotoninEvent::DeepEngagement); }
        let after = s.patience_score();
        assert!(after > before,
            "patience should rise with engagement streak: before={:.3} after={:.3}", before, after);
    }

    #[test]
    fn test_impulse_risk_when_low() {
        let mut s = SerotoninSystem::new();
        // Crash serotonin with conflicts
        for _ in 0..30 { s.process(SerotoninEvent::SocialConflict); }
        assert!(s.impulse_risk(),
            "many conflicts should trigger impulse risk (level={:.3})", s.level);
    }
}
