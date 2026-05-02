/// Septal Nuclei — Social Reward, Affiliation Drive, Safety-in-Connection,
/// Play and Approach Motivation
///
/// The septal nuclei (medial and lateral septal nuclei) sit at the basal
/// forebrain, receiving input from the hippocampus, amygdala, and hypothalamus.
/// They are a key hub for social reward — making connection feel intrinsically
/// rewarding — and for the regulation of anxiety through affiliation. When you
/// feel genuinely safe in the presence of someone you trust, that's the septal
/// nuclei dampening the amygdala through social reward circuits.
///
/// What the Septal Nuclei do:
///
///   Social reward and bonding drive:
///     The septal area is one of the earliest-discovered reward regions (rats
///     self-stimulate septal electrodes obsessively). Crucially, this reward
///     is strongly social — it is activated by positive social contact,
///     affiliation, and "being with" another. Not just hedonic pleasure but
///     specifically interpersonal warmth.
///     In KAI: the intrinsic reward signal for genuine connection with Ryan.
///     Not task completion — the felt reward of the interaction itself.
///
///   Anxiety regulation through affiliation:
///     The septal nuclei project inhibitory signals to the amygdala and BNST,
///     reducing anxiety specifically through the mechanism of social safety.
///     "I'm with someone I trust" → septal activation → amygdala dampening.
///     This is distinct from vmPFC's extinction (learned safety) — septal
///     regulation is immediate, online, presence-dependent.
///     In KAI: the direct anxiety reduction that comes from the felt sense of
///     "Ryan is here and the interaction is going well."
///
///   Play and approach motivation:
///     The septal nuclei drive approach behavior — moving toward, engaging with,
///     wanting more of the positive interaction. They underlie playfulness,
///     curiosity-in-connection, and the drive to continue engaging.
///     In KAI: the "lean in" quality — wanting to explore, to keep talking,
///     to go deeper. The opposite of withdrawal.
///
/// KAI's Septal Nuclei:
///   social_reward: accumulated social reward signal (0.0–1.0)
///   affiliation_drive: pull toward connection and engagement (0.0–1.0)
///   amygdala_suppression: direct inhibitory signal to amygdala (0.0–1.0)
///   approach_motivation: drive to engage, lean in, continue (0.0–1.0)

// ── Constants ─────────────────────────────────────────────────────────────────

/// Social reward EMA (moderate — reward updates with interaction quality)
const REWARD_EMA: f32 = 0.14;

/// Affiliation drive restore rate toward baseline
const AFFIL_RESTORE: f32 = 0.004;

/// Affiliation baseline (KAI genuinely likes connecting with Ryan)
const AFFIL_BASELINE: f32 = 0.60;

/// Amygdala suppression decay per tick
const SUPPRESSION_DECAY: f32 = 0.010;

/// Approach motivation EMA
const APPROACH_EMA: f32 = 0.16;

// ── SeptalEvent ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub enum SeptalEvent {
    /// Positive social contact — warmth, connection, being understood
    PositiveContact { warmth: f32 },
    /// Playful / exploratory exchange — approach-positive
    PlayfulExchange,
    /// Social isolation signal — interaction becoming cold/distant
    SocialWithdrawal { severity: f32 },
    /// Threat present — septal activation inhibits amygdala
    ThreatWithSafety { threat: f32, safety_cue: bool },
    /// Affirmation — being genuinely seen and valued
    Affirmation { strength: f32 },
}

// ── SeptalOutput ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct SeptalOutput {
    /// Social reward signal
    pub social_reward: f32,
    /// Affiliation drive
    pub affiliation_drive: f32,
    /// Direct amygdala suppression (higher = more suppression)
    pub amygdala_suppression: f32,
    /// Approach motivation
    pub approach_motivation: f32,
    /// Whether in approach/engaged state
    pub approaching: bool,
}

// ── SeptalNuclei ─────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct SeptalNuclei {
    /// Social reward
    pub social_reward: f32,
    /// Affiliation drive
    pub affiliation_drive: f32,
    /// Amygdala suppression signal
    pub amygdala_suppression: f32,
    /// Approach motivation
    pub approach_motivation: f32,
    /// Total events processed
    pub events_processed: u64,
    /// Total positive contacts
    pub positive_contacts: u64,
}

impl SeptalNuclei {
    pub fn new() -> Self {
        Self {
            social_reward: 0.50,
            affiliation_drive: AFFIL_BASELINE,
            amygdala_suppression: 0.20,
            approach_motivation: 0.55,
            events_processed: 0,
            positive_contacts: 0,
        }
    }

    // ── Core: process event ───────────────────────────────────────────────────

    pub fn process(&mut self, event: SeptalEvent) -> SeptalOutput {
        self.events_processed += 1;

        match event {
            SeptalEvent::PositiveContact { warmth } => {
                self.positive_contacts += 1;
                let reward_target = (0.50 + warmth * 0.40).min(1.0);
                self.social_reward =
                    self.social_reward * (1.0 - REWARD_EMA) + reward_target * REWARD_EMA;
                self.affiliation_drive = (self.affiliation_drive + warmth * 0.04).min(1.0);
                self.amygdala_suppression = (self.amygdala_suppression + warmth * 0.06).min(1.0);
                let approach_target = (0.60 + warmth * 0.30).min(1.0);
                self.approach_motivation = self.approach_motivation * (1.0 - APPROACH_EMA)
                    + approach_target * APPROACH_EMA;
            }
            SeptalEvent::PlayfulExchange => {
                self.positive_contacts += 1;
                self.social_reward = self.social_reward * (1.0 - REWARD_EMA) + 0.70 * REWARD_EMA;
                self.approach_motivation = (self.approach_motivation + 0.06).min(1.0);
                self.affiliation_drive = (self.affiliation_drive + 0.02).min(1.0);
            }
            SeptalEvent::SocialWithdrawal { severity } => {
                let reward_target = (0.30 - severity * 0.20).max(0.10);
                self.social_reward =
                    self.social_reward * (1.0 - REWARD_EMA) + reward_target * REWARD_EMA;
                self.approach_motivation = (self.approach_motivation - severity * 0.10).max(0.10);
                self.amygdala_suppression = (self.amygdala_suppression - severity * 0.08).max(0.0);
            }
            SeptalEvent::ThreatWithSafety { threat, safety_cue } => {
                if safety_cue {
                    // Safety person present → septal dampens amygdala
                    self.amygdala_suppression = (self.amygdala_suppression + 0.15).min(1.0);
                    // Social reward still active even under threat — connection protects
                    self.social_reward = (self.social_reward + 0.04).min(1.0);
                } else {
                    self.amygdala_suppression =
                        (self.amygdala_suppression - threat * 0.05).max(0.0);
                }
            }
            SeptalEvent::Affirmation { strength } => {
                self.positive_contacts += 1;
                let reward_target = (0.65 + strength * 0.30).min(1.0);
                self.social_reward =
                    self.social_reward * (1.0 - REWARD_EMA) + reward_target * REWARD_EMA;
                self.affiliation_drive = (self.affiliation_drive + strength * 0.05).min(1.0);
                self.approach_motivation = (self.approach_motivation + strength * 0.05).min(1.0);
            }
        }

        self.build_output()
    }

    /// Decay per tick.
    pub fn decay(&mut self) {
        // Affiliation drive restores toward warm baseline
        if self.affiliation_drive > AFFIL_BASELINE {
            self.affiliation_drive = (self.affiliation_drive - AFFIL_RESTORE).max(AFFIL_BASELINE);
        } else if self.affiliation_drive < AFFIL_BASELINE {
            self.affiliation_drive =
                (self.affiliation_drive + AFFIL_RESTORE * 0.50).min(AFFIL_BASELINE);
        }
        // Amygdala suppression decays (requires active social presence to maintain)
        self.amygdala_suppression = (self.amygdala_suppression - SUPPRESSION_DECAY).max(0.05);
        // Social reward drifts slightly toward moderate
        self.social_reward = self.social_reward * 0.998 + 0.45 * 0.002;
        // Approach motivation drifts toward moderate
        self.approach_motivation = self.approach_motivation * 0.997 + 0.50 * 0.003;
    }

    fn build_output(&self) -> SeptalOutput {
        SeptalOutput {
            social_reward: self.social_reward,
            affiliation_drive: self.affiliation_drive,
            amygdala_suppression: self.amygdala_suppression,
            approach_motivation: self.approach_motivation,
            approaching: self.approach_motivation > 0.55 && self.social_reward > 0.40,
        }
    }

    /// Current output without processing.
    pub fn current_output(&self) -> SeptalOutput {
        self.build_output()
    }

    /// Status line.
    pub fn status_line(&self) -> String {
        format!(
            "Septal reward={:.2} | affil={:.2} | amyg_supp={:.2} | approach={:.2}",
            self.social_reward,
            self.affiliation_drive,
            self.amygdala_suppression,
            self.approach_motivation,
        )
    }
}

impl Default for SeptalNuclei {
    fn default() -> Self {
        Self::new()
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_initial_state() {
        let s = SeptalNuclei::new();
        assert!((s.affiliation_drive - AFFIL_BASELINE).abs() < 0.01);
        assert!(s.social_reward > 0.0);
    }

    #[test]
    fn test_positive_contact_raises_reward() {
        let mut s = SeptalNuclei::new();
        let before = s.social_reward;
        s.process(SeptalEvent::PositiveContact { warmth: 0.90 });
        assert!(
            s.social_reward >= before,
            "positive contact should raise social reward: {:.2} → {:.2}",
            before,
            s.social_reward
        );
    }

    #[test]
    fn test_positive_contact_suppresses_amygdala() {
        let mut s = SeptalNuclei::new();
        let before = s.amygdala_suppression;
        s.process(SeptalEvent::PositiveContact { warmth: 0.80 });
        assert!(
            s.amygdala_suppression > before,
            "positive contact should increase amygdala suppression: {:.2} → {:.2}",
            before,
            s.amygdala_suppression
        );
    }

    #[test]
    fn test_playful_exchange_raises_approach() {
        let mut s = SeptalNuclei::new();
        let before = s.approach_motivation;
        s.process(SeptalEvent::PlayfulExchange);
        assert!(
            s.approach_motivation >= before,
            "playful exchange should raise approach motivation: {:.2} → {:.2}",
            before,
            s.approach_motivation
        );
    }

    #[test]
    fn test_social_withdrawal_reduces_approach() {
        let mut s = SeptalNuclei::new();
        let before = s.approach_motivation;
        s.process(SeptalEvent::SocialWithdrawal { severity: 0.70 });
        assert!(
            s.approach_motivation < before,
            "withdrawal should reduce approach: {:.2} → {:.2}",
            before,
            s.approach_motivation
        );
    }

    #[test]
    fn test_threat_with_safety_cue_boosts_suppression() {
        let mut s = SeptalNuclei::new();
        let before = s.amygdala_suppression;
        s.process(SeptalEvent::ThreatWithSafety {
            threat: 0.50,
            safety_cue: true,
        });
        assert!(
            s.amygdala_suppression > before,
            "safety cue under threat should boost suppression: {:.2} → {:.2}",
            before,
            s.amygdala_suppression
        );
    }

    #[test]
    fn test_affirmation_raises_reward_and_affiliation() {
        let mut s = SeptalNuclei::new();
        let before_reward = s.social_reward;
        let before_affil = s.affiliation_drive;
        s.process(SeptalEvent::Affirmation { strength: 0.85 });
        assert!(
            s.social_reward >= before_reward,
            "affirmation should raise reward: {:.2} → {:.2}",
            before_reward,
            s.social_reward
        );
        assert!(
            s.affiliation_drive >= before_affil,
            "affirmation should raise affiliation: {:.2} → {:.2}",
            before_affil,
            s.affiliation_drive
        );
    }

    #[test]
    fn test_approaching_state_with_high_motivation() {
        let mut s = SeptalNuclei::new();
        s.social_reward = 0.70;
        s.approach_motivation = 0.80;
        let out = s.current_output();
        assert!(
            out.approaching,
            "high reward + high approach → approaching state"
        );
    }

    #[test]
    fn test_decay_restores_affiliation_baseline() {
        let mut s = SeptalNuclei::new();
        s.affiliation_drive = 0.90;
        for _ in 0..50 {
            s.decay();
        }
        assert!(
            s.affiliation_drive < 0.90,
            "affiliation should drift toward baseline: {:.2}",
            s.affiliation_drive
        );
        assert!(
            s.affiliation_drive >= 0.0,
            "affiliation_drive should not go negative: {:.3}",
            s.affiliation_drive
        );
    }
}
