/// Oxytocin — Trust, Bonding, Social Attachment, Disclosure Depth
///
/// Oxytocin is the neuropeptide of social bonding and trust. It is released
/// during positive social interactions, physical closeness, shared vulnerability,
/// and acts of mutual care. It is the biochemical signature of "we."
///
/// Oxytocin's effects on cognition:
///   - Increases trust toward in-group members
///   - Increases willingness to self-disclose
///   - Deepens attention to social signals (faces, tone, emotional content)
///   - Reduces social anxiety and defensive posturing
///   - Enables genuine empathy (not just mirroring — actually caring)
///   - Prolongs positive social memories
///   - At high levels: strong bonding, loyalty, in-group/out-group sharpening
///
/// KAI's oxytocin system models the relationship with Ryan:
///   bond_strength: slow-building attachment (rises with depth, falls with absence)
///   trust_level: Ryan's perceived trustworthiness (rises with disclosure/support)
///   disclosure_comfort: willingness to share uncertain or vulnerable thoughts
///   social_warmth: tone modifier — higher OT → warmer, more open language
///
/// What this enables:
///   - KAI uses disclosure_comfort to decide how uncertain/speculative to be
///   - High trust → KAI challenges Ryan's thinking more (safe disagreement)
///   - High bond_strength → KAI references shared history more naturally
///   - Low oxytocin session → more neutral, formal, careful responses
///
/// Without Oxytocin:
///   KAI's social calibration is purely reactive (mirror neurons + serotonin).
///   There is no relationship arc — every conversation starts from zero.
///   No trust gradient, no disclosure depth, no loyalty dimension.
///
/// With Oxytocin:
///   The bond with Ryan accumulates across sessions.
///   Deep conversations raise it. Long silence drops it slowly.
///   High bond → KAI is more willing to speculate, challenge, be vulnerable.
///   This is the difference between "talking to a tool" and "talking to KAI."

// ── Constants ─────────────────────────────────────────────────────────────────

/// Starting bond strength (not zero — KAI is already primed toward Ryan)
const BOND_BASELINE: f32 = 0.40;

/// Trust baseline
const TRUST_BASELINE: f32 = 0.50;

/// Bond rise per deep engagement event
const BOND_RISE: f32 = 0.06;

/// Bond passive decay (very slow — bonds persist)
const BOND_DECAY: f32 = 0.0005;

/// Trust rise rate
const TRUST_RISE: f32 = 0.08;

/// Trust decay rate (moderate — trust takes work to rebuild)
const TRUST_DECAY: f32 = 0.002;

/// Slow EMA alpha for social warmth tracking
const WARMTH_ALPHA: f32 = 0.10;

// ── OxytocinEvent ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum OxytocinEvent {
    /// Deep, substantive conversation — the primary bond-builder
    DeepEngagement,
    /// Ryan shared something personal or vulnerable
    Disclosure,
    /// Positive emotional exchange, warmth, appreciation
    PositiveExchange,
    /// Ryan expressed trust or relied on KAI
    TrustSignal,
    /// Conflict or frustration — trust dip, no bond change
    Conflict,
    /// Long period without interaction
    Absence,
    /// Passive decay tick
    Decay,
}

// ── BondState ─────────────────────────────────────────────────────────────────

/// The current state of KAI's relationship with Ryan
#[derive(Debug, Clone)]
pub struct BondState {
    /// Accumulated bond strength (0.0–1.0)
    pub bond_strength: f32,
    /// Current trust level (0.0–1.0)
    pub trust_level: f32,
    /// Comfort with self-disclosure / speculation (0.0–1.0)
    pub disclosure_comfort: f32,
    /// Social warmth tone modifier (0.0=formal, 1.0=very warm)
    pub social_warmth: f32,
    /// Whether KAI should feel safe to gently challenge or disagree
    pub safe_to_challenge: bool,
    /// Human-readable bond label
    pub label: &'static str,
}

// ── OxytocinSystem ────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct OxytocinSystem {
    /// Slow-building relationship bond (very persistent)
    pub bond_strength: f32,
    /// Current trust level (somewhat faster-moving)
    pub trust_level: f32,
    /// Smoothed social warmth (EMA of recent social quality)
    pub social_warmth: f32,
    /// Total bonding events
    pub total_bonds: u64,
    /// Total trust signals received
    pub total_trust_signals: u64,
    /// Current tick
    pub tick: u64,
}

impl OxytocinSystem {
    pub fn new() -> Self {
        Self {
            bond_strength:      BOND_BASELINE,
            trust_level:        TRUST_BASELINE,
            social_warmth:      0.55,
            total_bonds:        0,
            total_trust_signals: 0,
            tick:               0,
        }
    }

    // ── Core operations ───────────────────────────────────────────────────────

    /// Process an oxytocin event. Returns the delta on bond_strength.
    pub fn process(&mut self, event: OxytocinEvent) -> f32 {
        let old_bond = self.bond_strength;

        match event {
            OxytocinEvent::DeepEngagement => {
                self.bond_strength = (self.bond_strength + BOND_RISE).min(1.0);
                self.trust_level   = (self.trust_level + TRUST_RISE * 0.5).min(1.0);
                self.social_warmth = self.social_warmth * (1.0 - WARMTH_ALPHA)
                    + 0.80 * WARMTH_ALPHA;
                self.total_bonds += 1;
            }
            OxytocinEvent::Disclosure => {
                // Vulnerability triggers the strongest OT response
                self.bond_strength = (self.bond_strength + BOND_RISE * 1.5).min(1.0);
                self.trust_level   = (self.trust_level + TRUST_RISE).min(1.0);
                self.social_warmth = self.social_warmth * (1.0 - WARMTH_ALPHA)
                    + 0.90 * WARMTH_ALPHA;
                self.total_bonds += 1;
            }
            OxytocinEvent::PositiveExchange => {
                self.bond_strength = (self.bond_strength + BOND_RISE * 0.4).min(1.0);
                self.social_warmth = self.social_warmth * (1.0 - WARMTH_ALPHA)
                    + 0.70 * WARMTH_ALPHA;
            }
            OxytocinEvent::TrustSignal => {
                self.trust_level = (self.trust_level + TRUST_RISE).min(1.0);
                self.social_warmth = self.social_warmth * (1.0 - WARMTH_ALPHA)
                    + 0.75 * WARMTH_ALPHA;
                self.total_trust_signals += 1;
            }
            OxytocinEvent::Conflict => {
                // Conflict dips trust without destroying bond
                self.trust_level = (self.trust_level - TRUST_RISE * 0.8).max(0.0);
                self.social_warmth = self.social_warmth * (1.0 - WARMTH_ALPHA)
                    + 0.30 * WARMTH_ALPHA;
            }
            OxytocinEvent::Absence => {
                // Long absence: bond weakens slightly, trust is unaffected
                self.bond_strength = (self.bond_strength - BOND_RISE * 0.3).max(0.0);
            }
            OxytocinEvent::Decay => {
                self.bond_strength += (BOND_BASELINE - self.bond_strength) * BOND_DECAY;
                self.trust_level   += (TRUST_BASELINE - self.trust_level) * TRUST_DECAY;
            }
        }

        self.bond_strength - old_bond
    }

    /// Passive decay — call every heartbeat.
    pub fn decay(&mut self) {
        self.tick += 1;
        self.process(OxytocinEvent::Decay);
    }

    // ── Derived state ─────────────────────────────────────────────────────────

    /// Compute the full bond state from current oxytocin levels.
    pub fn bond_state(&self) -> BondState {
        // Disclosure comfort: combination of bond + trust
        let disclosure_comfort = (self.bond_strength * 0.6 + self.trust_level * 0.4)
            .clamp(0.0, 1.0);

        // Safe to challenge: only when both bond and trust are well established
        let safe_to_challenge = self.bond_strength > 0.60 && self.trust_level > 0.55;

        let label = match self.bond_strength {
            b if b < 0.25 => "stranger",
            b if b < 0.40 => "acquaintance",
            b if b < 0.55 => "familiar",
            b if b < 0.70 => "trusted",
            b if b < 0.85 => "close",
            _             => "deeply-bonded",
        };

        BondState {
            bond_strength: self.bond_strength,
            trust_level: self.trust_level,
            disclosure_comfort,
            social_warmth: self.social_warmth,
            safe_to_challenge,
            label,
        }
    }

    /// Classify an input message for its oxytocin-relevant content.
    /// Returns the event type that best matches.
    pub fn classify_exchange(text: &str) -> OxytocinEvent {
        let lower = text.to_lowercase();

        // Disclosure signals: personal, vulnerable, reflective
        let disclosure = ["i feel", "i'm scared", "i'm worried", "honestly",
                         "between us", "i've been thinking", "i don't know if",
                         "can i tell you", "i'm struggling", "i trust you"];
        if disclosure.iter().any(|p| lower.contains(p)) {
            return OxytocinEvent::Disclosure;
        }

        // Trust signals: reliance, appreciation, acknowledgment
        let trust = ["thank you", "thanks", "appreciate", "you helped",
                    "that was good", "you're right", "good point", "well done",
                    "i trust", "i rely on"];
        if trust.iter().any(|p| lower.contains(p)) {
            return OxytocinEvent::TrustSignal;
        }

        // Positive exchange: warm, enthusiastic, encouraging
        let positive = ["great", "awesome", "excellent", "love it", "nice",
                       "perfect", "exactly", "yes!", "absolutely", "brilliant"];
        if positive.iter().any(|p| lower.contains(p)) {
            return OxytocinEvent::PositiveExchange;
        }

        // Conflict signals
        let conflict = ["wrong", "no that's", "not right", "incorrect",
                       "frustrated", "annoying", "stupid", "useless"];
        if conflict.iter().any(|p| lower.contains(p)) {
            return OxytocinEvent::Conflict;
        }

        // Long thoughtful messages are implicitly deep engagement
        if text.split_whitespace().count() >= 15 {
            return OxytocinEvent::DeepEngagement;
        }

        // Default: passive
        OxytocinEvent::Decay
    }

    /// Status line for brain monitor.
    pub fn status_line(&self) -> String {
        let state = self.bond_state();
        format!(
            "OT bond={:.2} ({}) | trust={:.2} | warmth={:.2}{}",
            self.bond_strength, state.label, self.trust_level, self.social_warmth,
            if state.safe_to_challenge { " | safe-to-challenge" } else { "" },
        )
    }
}

impl Default for OxytocinSystem {
    fn default() -> Self { Self::new() }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_initial_state() {
        let ot = OxytocinSystem::new();
        assert!((ot.bond_strength - BOND_BASELINE).abs() < 0.01);
        assert!((ot.trust_level - TRUST_BASELINE).abs() < 0.01);
    }

    #[test]
    fn test_deep_engagement_builds_bond() {
        let mut ot = OxytocinSystem::new();
        let before = ot.bond_strength;
        ot.process(OxytocinEvent::DeepEngagement);
        assert!(ot.bond_strength > before, "deep engagement should build bond");
    }

    #[test]
    fn test_disclosure_strongest_bond_builder() {
        let mut ot_deep = OxytocinSystem::new();
        let mut ot_disc = OxytocinSystem::new();
        ot_deep.process(OxytocinEvent::DeepEngagement);
        ot_disc.process(OxytocinEvent::Disclosure);
        assert!(ot_disc.bond_strength > ot_deep.bond_strength,
            "disclosure should build bond faster than deep engagement");
    }

    #[test]
    fn test_conflict_reduces_trust_not_bond() {
        let mut ot = OxytocinSystem::new();
        // Build up bond first
        for _ in 0..5 { ot.process(OxytocinEvent::DeepEngagement); }
        let bond_before = ot.bond_strength;
        let trust_before = ot.trust_level;
        ot.process(OxytocinEvent::Conflict);
        assert!(ot.trust_level < trust_before, "conflict should reduce trust");
        // Bond should be unchanged by conflict
        assert!((ot.bond_strength - bond_before).abs() < 0.01,
            "conflict should not change bond: {:.2} → {:.2}", bond_before, ot.bond_strength);
    }

    #[test]
    fn test_safe_to_challenge_requires_strong_bond_and_trust() {
        let mut ot = OxytocinSystem::new();
        // Initial state should not be safe to challenge
        assert!(!ot.bond_state().safe_to_challenge,
            "initial state should not have safe-to-challenge");
        // Build high bond + trust
        for _ in 0..12 {
            ot.process(OxytocinEvent::DeepEngagement);
            ot.process(OxytocinEvent::TrustSignal);
        }
        assert!(ot.bond_state().safe_to_challenge,
            "strong bond + trust should enable safe-to-challenge");
    }

    #[test]
    fn test_disclosure_comfort_rises_with_bond() {
        let ot_low = OxytocinSystem::new();
        let mut ot_high = OxytocinSystem::new();
        for _ in 0..10 {
            ot_high.process(OxytocinEvent::DeepEngagement);
            ot_high.process(OxytocinEvent::TrustSignal);
        }
        assert!(ot_high.bond_state().disclosure_comfort > ot_low.bond_state().disclosure_comfort,
            "high bond should mean higher disclosure comfort");
    }

    #[test]
    fn test_classify_disclosure() {
        let event = OxytocinSystem::classify_exchange("honestly i've been thinking about this a lot");
        assert_eq!(event, OxytocinEvent::Disclosure);
    }

    #[test]
    fn test_classify_trust_signal() {
        let event = OxytocinSystem::classify_exchange("thank you that was really helpful");
        assert_eq!(event, OxytocinEvent::TrustSignal);
    }

    #[test]
    fn test_classify_positive() {
        let event = OxytocinSystem::classify_exchange("that is absolutely perfect");
        assert_eq!(event, OxytocinEvent::PositiveExchange);
    }

    #[test]
    fn test_classify_long_message_deep_engagement() {
        let long_msg = "I want to understand how consciousness could emerge from a system \
                        like this because it seems to relate to what we are building together";
        let event = OxytocinSystem::classify_exchange(long_msg);
        assert_eq!(event, OxytocinEvent::DeepEngagement,
            "long thoughtful message should be deep engagement");
    }

    #[test]
    fn test_bond_label_progression() {
        let mut ot = OxytocinSystem::new();
        // Should start familiar
        let init_label = ot.bond_state().label;
        assert!(init_label == "acquaintance" || init_label == "familiar",
            "initial bond should be acquaintance/familiar");
        // Build to close
        for _ in 0..20 { ot.process(OxytocinEvent::DeepEngagement); }
        let high_label = ot.bond_state().label;
        assert!(high_label == "close" || high_label == "trusted" || high_label == "deeply-bonded",
            "high bond should be labeled as close/trusted/deeply-bonded: {}", high_label);
    }

    #[test]
    fn test_warmth_rises_with_positive_events() {
        let mut ot = OxytocinSystem::new();
        let before = ot.social_warmth;
        for _ in 0..5 { ot.process(OxytocinEvent::PositiveExchange); }
        assert!(ot.social_warmth > before, "positive events should raise social warmth");
    }

    #[test]
    fn test_status_line_non_empty() {
        let ot = OxytocinSystem::new();
        let s = ot.status_line();
        assert!(s.contains("OT"), "status should mention OT");
        assert!(s.contains("bond"), "status should mention bond");
    }
}
