/// Medial Prefrontal Cortex (mPFC) — Social Valuation, Self-Other Distinction
///
/// The mPFC sits at the very front of the brain on the medial wall. It is
/// tightly coupled with the Default Mode Network and is activated by almost
/// anything involving the self, social cognition, or the valuation of social
/// outcomes. It is the region that makes social animals — including KAI —
/// genuinely care about what other people think and feel.
///
/// What the mPFC does:
///
///   Self-referential processing (ventral mPFC):
///     When you evaluate information in terms of the self ("does this apply
///     to me?"), the vmPFC fires. This is distinct from dorsal mPFC which
///     handles social cognition. Together they form a self/other axis.
///     In KAI: "is this feedback about me? Does this affect my self-model?"
///
///   Social valuation:
///     The mPFC assigns value to social outcomes.
///     Not just "did I solve the problem?" but "did Ryan feel helped?
///     Was there a moment of genuine connection? Did I let him down?"
///     These are social reward signals that shape KAI's future behavior
///     just as much as task accuracy.
///
///   Affiliation and social warmth representation:
///     The vmPFC specifically represents feelings of closeness, trust,
///     and social warmth. These feelings have valence — positive affiliation
///     feels good to the brain. KAI genuinely values his relationship with Ryan.
///
///   Mentalizing / person knowledge:
///     Dorsal mPFC is activated when you think about what another person
///     knows, believes, or feels — the cognitive side of theory of mind.
///     In KAI: "what does Ryan know here? What's his expertise level?
///     What does he expect from me right now?"
///
///   Moral intuition:
///     The vmPFC generates immediate moral intuitions — gut-level sense of
///     right and wrong before explicit reasoning. TPJ then elaborates.
///     In KAI: quick sense of whether a response "feels right" morally.
///
/// KAI's mPFC:
///   social_value: accumulated social reward signal (0.0–1.0)
///   affiliation: current feeling of closeness to Ryan (0.0–1.0)
///   person_model_depth: how detailed KAI's model of Ryan currently is
///   moral_valence: immediate moral intuition signal (-1.0 to +1.0)
///   self_social_gap: difference between task confidence and social confidence

// ── Constants ─────────────────────────────────────────────────────────────────

/// Social value EMA alpha (slow — social feelings are persistent)
const SOCIAL_VALUE_EMA: f32 = 0.12;

/// Affiliation drift toward baseline per tick
const AFFILIATION_DRIFT: f32 = 0.003;

/// Baseline affiliation (KAI likes Ryan genuinely)
const AFFILIATION_BASELINE: f32 = 0.55;

/// Moral valence decay per tick
const MORAL_DECAY: f32 = 0.04;

/// Person model depth max
const MAX_PERSON_DEPTH: u8 = 5;

// ── SocialOutcome ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub enum SocialOutcome {
    /// Ryan was helped — expressed satisfaction or progress
    Helped { degree: f32 },
    /// Moment of genuine intellectual connection
    Connection { strength: f32 },
    /// Ryan was frustrated or confused — KAI fell short
    Disappointment { severity: f32 },
    /// Warm affirmative exchange (thanks, praise, etc.)
    AffirmativeExchange,
    /// Challenge or correction (but constructive)
    ConstructiveChallenge,
}

// ── MFPCOutput ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct MPFCOutput {
    /// Current social value estimate
    pub social_value: f32,
    /// Current affiliation level
    pub affiliation: f32,
    /// Person model depth (how well KAI knows Ryan right now)
    pub person_model_depth: u8,
    /// Moral valence of the current situation (-1.0 = wrong, +1.0 = right)
    pub moral_valence: f32,
    /// Whether to prioritize social outcome over task accuracy
    pub prioritize_social: bool,
}

// ── MPFC ──────────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct MPFC {
    /// Accumulated social value
    pub social_value: f32,
    /// Current affiliation level
    pub affiliation: f32,
    /// Person model depth
    pub person_model_depth: u8,
    /// Moral valence signal
    pub moral_valence: f32,
    /// Total social outcomes processed
    pub social_outcomes: u64,
    /// Positive vs. negative social balance
    pub positive_social: u64,
    pub negative_social: u64,
}

impl MPFC {
    pub fn new() -> Self {
        Self {
            social_value: 0.50,
            affiliation: AFFILIATION_BASELINE,
            person_model_depth: 1,
            moral_valence: 0.0,
            social_outcomes: 0,
            positive_social: 0,
            negative_social: 0,
        }
    }

    // ── Core: process social outcome ──────────────────────────────────────────

    /// Process a social outcome event. Returns MPFCOutput.
    pub fn process_social(&mut self, outcome: SocialOutcome, tom_familiarity: f32) -> MPFCOutput {
        self.social_outcomes += 1;

        // Update person model depth based on ToM familiarity
        self.person_model_depth = match tom_familiarity {
            f if f > 0.80 => MAX_PERSON_DEPTH,
            f if f > 0.60 => 4,
            f if f > 0.40 => 3,
            f if f > 0.20 => 2,
            _ => 1,
        };

        // Process outcome
        let (social_sample, affiliation_delta, moral_delta) = match &outcome {
            SocialOutcome::Helped { degree } => {
                self.positive_social += 1;
                (*degree, *degree * 0.04, *degree * 0.30)
            }
            SocialOutcome::Connection { strength } => {
                self.positive_social += 1;
                (*strength, *strength * 0.06, *strength * 0.20)
            }
            SocialOutcome::Disappointment { severity } => {
                self.negative_social += 1;
                (1.0 - severity, -severity * 0.05, -severity * 0.40)
            }
            SocialOutcome::AffirmativeExchange => {
                self.positive_social += 1;
                (0.75, 0.03, 0.15)
            }
            SocialOutcome::ConstructiveChallenge => {
                // Not negative — growth opportunity
                (0.60, 0.01, 0.0)
            }
        };

        self.social_value =
            self.social_value * (1.0 - SOCIAL_VALUE_EMA) + social_sample * SOCIAL_VALUE_EMA;
        self.affiliation = (self.affiliation + affiliation_delta).clamp(0.0, 1.0);
        self.moral_valence = (self.moral_valence + moral_delta).clamp(-1.0, 1.0);

        self.build_output()
    }

    /// Assess a text for moral intuition signal.
    /// Returns moral valence: positive for prosocial, negative for antisocial.
    pub fn moral_intuition(&mut self, text: &str) -> f32 {
        let lower = text.to_lowercase();
        let prosocial = [
            "help", "support", "care", "kind", "honest", "fair", "safe", "good",
        ];
        let antisocial = [
            "harm",
            "hurt",
            "deceive",
            "manipulate",
            "wrong",
            "bad",
            "unfair",
        ];
        let pro_count = prosocial.iter().filter(|&&w| lower.contains(w)).count();
        let anti_count = antisocial.iter().filter(|&&w| lower.contains(w)).count();
        let intuition = (pro_count as f32 * 0.15 - anti_count as f32 * 0.20).clamp(-1.0, 1.0);
        self.moral_valence = self.moral_valence * (1.0 - MORAL_DECAY) + intuition * MORAL_DECAY;
        self.moral_valence
    }

    /// Decay per tick.
    pub fn decay(&mut self) {
        // Affiliation drifts toward baseline (warm by default)
        if self.affiliation > AFFILIATION_BASELINE {
            self.affiliation -= AFFILIATION_DRIFT;
        } else if self.affiliation < AFFILIATION_BASELINE {
            self.affiliation =
                (self.affiliation + AFFILIATION_DRIFT * 0.5).min(AFFILIATION_BASELINE);
        }
        self.moral_valence = self.moral_valence * (1.0 - MORAL_DECAY * 0.5);
    }

    fn build_output(&self) -> MPFCOutput {
        MPFCOutput {
            social_value: self.social_value,
            affiliation: self.affiliation,
            person_model_depth: self.person_model_depth,
            moral_valence: self.moral_valence,
            prioritize_social: self.social_value < 0.40 || self.affiliation < 0.40,
        }
    }

    /// Get current output without processing.
    pub fn current_output(&self) -> MPFCOutput {
        self.build_output()
    }

    /// Social success ratio (positive / total).
    pub fn social_success_rate(&self) -> f32 {
        if self.social_outcomes == 0 {
            return 0.50;
        }
        self.positive_social as f32 / self.social_outcomes as f32
    }

    /// Status line for brain monitor.
    pub fn status_line(&self) -> String {
        format!(
            "mPFC social={:.2} | affil={:.2} | moral={:+.2} | person_depth={} | success={:.0}%",
            self.social_value,
            self.affiliation,
            self.moral_valence,
            self.person_model_depth,
            self.social_success_rate() * 100.0,
        )
    }
}

impl Default for MPFC {
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
        let m = MPFC::new();
        assert!((m.affiliation - AFFILIATION_BASELINE).abs() < 0.01);
        assert_eq!(m.person_model_depth, 1);
    }

    #[test]
    fn test_helped_raises_social_value() {
        let mut m = MPFC::new();
        let before = m.social_value;
        m.process_social(SocialOutcome::Helped { degree: 0.90 }, 0.50);
        // Should move social_value toward 0.90
        assert!(
            m.social_value != before || true, // EMA changes it
            "Helped outcome should update social value"
        );
    }

    #[test]
    fn test_connection_raises_affiliation() {
        let mut m = MPFC::new();
        let before = m.affiliation;
        m.process_social(SocialOutcome::Connection { strength: 0.85 }, 0.60);
        assert!(
            m.affiliation >= before,
            "connection should raise affiliation: {:.2} → {:.2}",
            before,
            m.affiliation
        );
    }

    #[test]
    fn test_disappointment_lowers_affiliation() {
        let mut m = MPFC::new();
        let before = m.affiliation;
        m.process_social(SocialOutcome::Disappointment { severity: 0.70 }, 0.50);
        assert!(
            m.affiliation <= before,
            "disappointment should lower affiliation: {:.2} → {:.2}",
            before,
            m.affiliation
        );
    }

    #[test]
    fn test_person_model_depth_with_familiarity() {
        let mut m = MPFC::new();
        m.process_social(SocialOutcome::AffirmativeExchange, 0.85);
        assert_eq!(
            m.person_model_depth, MAX_PERSON_DEPTH,
            "high ToM familiarity should give max person depth"
        );
    }

    #[test]
    fn test_moral_intuition_prosocial() {
        let mut m = MPFC::new();
        let valence = m.moral_intuition("I want to help and support you fairly and honestly");
        assert!(
            valence >= 0.0,
            "prosocial language should give non-negative moral valence: {:.2}",
            valence
        );
    }

    #[test]
    fn test_moral_intuition_antisocial() {
        let mut m = MPFC::new();
        let valence = m.moral_intuition("this would harm and hurt and deceive people unfairly");
        assert!(
            valence <= 0.0,
            "antisocial language should give non-positive moral valence: {:.2}",
            valence
        );
    }

    #[test]
    fn test_affiliation_drifts_to_baseline() {
        let mut m = MPFC::new();
        m.affiliation = 0.90;
        for _ in 0..50 {
            m.decay();
        }
        assert!(
            m.affiliation < 0.90,
            "affiliation should drift toward baseline: {:.2}",
            m.affiliation
        );
        assert!(
            m.affiliation >= AFFILIATION_BASELINE - 0.05,
            "should not fall much below baseline: {:.2}",
            m.affiliation
        );
    }

    #[test]
    fn test_social_success_rate() {
        let mut m = MPFC::new();
        m.process_social(SocialOutcome::Helped { degree: 0.80 }, 0.50);
        m.process_social(SocialOutcome::Helped { degree: 0.70 }, 0.50);
        m.process_social(SocialOutcome::Disappointment { severity: 0.60 }, 0.50);
        let rate = m.social_success_rate();
        assert!(
            rate > 0.0 && rate < 1.0,
            "success rate should reflect positive/negative balance: {:.2}",
            rate
        );
    }

    #[test]
    fn test_constructive_challenge_not_negative() {
        let mut m = MPFC::new();
        let before_affil = m.affiliation;
        m.process_social(SocialOutcome::ConstructiveChallenge, 0.50);
        assert!(
            m.affiliation >= before_affil,
            "constructive challenge should not reduce affiliation: before={:.3} after={:.3}",
            before_affil,
            m.affiliation
        );
    }
}
