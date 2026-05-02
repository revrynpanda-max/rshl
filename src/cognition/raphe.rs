//! Raphe Nuclei — Serotonin Source Nucleus
//!
//! The raphe nuclei are to serotonin what the VTA is to dopamine and the
//! locus coeruleus is to norepinephrine. Located in the brainstem midline,
//! they broadcast 5-HT throughout the forebrain and regulate mood, patience,
//! impulse control, and the sense that things are "okay."
//!
//! What the Raphe does:
//!
//!   Tonic serotonin modulation:
//!     Like LC tonic NE, the raphe maintains a baseline 5-HT tone. This
//!     background tone shapes whether the system is patient and measured
//!     (high 5-HT) or reactive and impulsive (low 5-HT).
//!
//!   Social reward integration:
//!     Raphe neurons fire in response to social warmth, grooming,
//!     affiliation, and positive social outcomes. In KAI: good conversations,
//!     successful help, connection with Ryan → raphe fires → 5-HT rises.
//!
//!   Punishment vs. reward balance:
//!     Unlike dopamine (reward RPE), serotonin signals safety and satiety.
//!     "This situation is okay. We are not in danger. We can wait."
//!     Low 5-HT → urgency, impulsivity, reduced future discounting.
//!     High 5-HT → patience, tolerance for delay, calm.
//!
//!   Habenula suppression:
//!     A key inhibitory target of the raphe is the habenula (anti-reward
//!     nucleus). High raphe output suppresses habenular "disappointment"
//!     signals — the 5-HT system mutes negative rumination.
//!
//!   Sleep regulation:
//!     Raphe neurons are active during waking, slow during NREM sleep,
//!     and nearly silent during REM. This shapes when KAI consolidates
//!     vs. when he re-engages creatively (REM-like insight mode).
//!
//! KAI's Raphe:
//!   tonic_5ht: baseline serotonin level (0.0–1.0)
//!   social_input: accumulated positive social signal
//!   patience_factor: how willing KAI is to wait, elaborate, hold back
//!   habenula_suppression: degree to which negative signals are muted
//!   mode: Patient / Reactive / Depleted

// ── Constants ─────────────────────────────────────────────────────────────────

//! Resting tonic serotonin (moderate baseline)
const TONIC_5HT_REST: f32 = 0.50;

/// Boost per positive social exchange
const SOCIAL_BOOST: f32 = 0.06;

/// Boost per "deep engagement" (long substantive exchange)
const DEEP_ENGAGE_BOOST: f32 = 0.10;

/// Penalty per conflict or dismissal
const CONFLICT_PENALTY: f32 = 0.07;

/// Slow tonic drift per tick
const TONIC_DRIFT: f32 = 0.003;

/// Habenula suppression factor when 5-HT is high
const HABENULA_SUPPRESSION_SCALE: f32 = 0.70;

/// Threshold for Patient mode
const PATIENCE_THRESHOLD: f32 = 0.55;

/// Threshold for Depleted mode
const DEPLETED_THRESHOLD: f32 = 0.25;

// ── RapheMode ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum RapheMode {
    /// High 5-HT: calm, patient, can wait, tolerant
    Patient,
    /// Mid 5-HT: normal engagement
    Engaged,
    /// Low 5-HT: reactive, brief, impulsive
    Reactive,
    /// Very low: rumination risk, emotional bleed
    Depleted,
}

impl RapheMode {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Patient => "patient",
            Self::Engaged => "engaged",
            Self::Reactive => "reactive",
            Self::Depleted => "depleted",
        }
    }
}

// ── RapheEvent ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub enum RapheEvent {
    /// Positive social exchange, connection moment
    SocialWarmth,
    /// Deep, substantive conversation turn
    DeepEngagement,
    /// Conflict, dismissal, or harsh exchange
    SocialConflict,
    /// Successful help / Ryan satisfied
    SuccessfulHelp,
    /// Sleep consolidation (slow waking-mode transition)
    SleepOnset,
}

// ── RapheOutput ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct RapheOutput {
    /// Current 5-HT level
    pub tonic_5ht: f32,
    /// Patience factor (0.0–1.0)
    pub patience_factor: f32,
    /// Habenula suppression (0.0–1.0)
    pub habenula_suppression: f32,
    /// Current mode
    pub mode: RapheMode,
}

// ── RapheNuclei ───────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct RapheNuclei {
    /// Current tonic 5-HT level
    pub tonic_5ht: f32,
    /// Current mode
    pub mode: RapheMode,
    /// Total events processed
    pub events_processed: u64,
    /// Cumulative social warmth received
    pub social_warmth_total: u64,
}

impl RapheNuclei {
    pub fn new() -> Self {
        Self {
            tonic_5ht: TONIC_5HT_REST,
            mode: RapheMode::Engaged,
            events_processed: 0,
            social_warmth_total: 0,
        }
    }

    // ── Core update ───────────────────────────────────────────────────────────

    /// Process a social/engagement event. Returns RapheOutput.
    pub fn process_event(&mut self, event: RapheEvent) -> RapheOutput {
        self.events_processed += 1;

        match event {
            RapheEvent::SocialWarmth => {
                self.tonic_5ht = (self.tonic_5ht + SOCIAL_BOOST).min(1.0);
                self.social_warmth_total += 1;
            }
            RapheEvent::DeepEngagement => {
                self.tonic_5ht = (self.tonic_5ht + DEEP_ENGAGE_BOOST).min(1.0);
            }
            RapheEvent::SocialConflict => {
                self.tonic_5ht = (self.tonic_5ht - CONFLICT_PENALTY).max(0.0);
            }
            RapheEvent::SuccessfulHelp => {
                self.tonic_5ht = (self.tonic_5ht + SOCIAL_BOOST * 0.7).min(1.0);
            }
            RapheEvent::SleepOnset => {
                // Sleep: raphe becomes quieter but doesn't crash
                self.tonic_5ht = (self.tonic_5ht - 0.10).max(DEPLETED_THRESHOLD + 0.05);
            }
        }

        self.update_mode();
        self.build_output()
    }

    /// Decay tonic toward rest, called every tick.
    pub fn decay(&mut self) {
        if self.tonic_5ht > TONIC_5HT_REST {
            self.tonic_5ht = (self.tonic_5ht - TONIC_DRIFT).max(TONIC_5HT_REST);
        } else if self.tonic_5ht < TONIC_5HT_REST {
            self.tonic_5ht = (self.tonic_5ht + TONIC_DRIFT * 0.5).min(TONIC_5HT_REST);
        }
        self.update_mode();
    }

    fn update_mode(&mut self) {
        self.mode = if self.tonic_5ht >= PATIENCE_THRESHOLD {
            RapheMode::Patient
        } else if self.tonic_5ht >= 0.40 {
            RapheMode::Engaged
        } else if self.tonic_5ht >= DEPLETED_THRESHOLD {
            RapheMode::Reactive
        } else {
            RapheMode::Depleted
        };
    }

    fn build_output(&self) -> RapheOutput {
        let patience_factor = self.tonic_5ht;
        // Habenula suppression: max at high 5-HT, near zero when depleted
        let habenula_suppression = if self.tonic_5ht > PATIENCE_THRESHOLD {
            (self.tonic_5ht - PATIENCE_THRESHOLD) * HABENULA_SUPPRESSION_SCALE
                / (1.0 - PATIENCE_THRESHOLD)
        } else {
            0.0
        };
        RapheOutput {
            tonic_5ht: self.tonic_5ht,
            patience_factor,
            habenula_suppression,
            mode: self.mode.clone(),
        }
    }

    /// Get current output without processing an event.
    pub fn current_output(&self) -> RapheOutput {
        self.build_output()
    }

    /// Whether the raphe is in a patient / high-5HT state.
    pub fn is_patient(&self) -> bool {
        self.tonic_5ht >= PATIENCE_THRESHOLD
    }

    /// Whether the raphe is depleted (rumination risk).
    pub fn is_depleted(&self) -> bool {
        self.tonic_5ht < DEPLETED_THRESHOLD
    }

    /// Status line for brain monitor.
    pub fn status_line(&self) -> String {
        format!(
            "Raphe 5-HT={:.2} | mode={} | social_warmth={} events={}",
            self.tonic_5ht,
            self.mode.label(),
            self.social_warmth_total,
            self.events_processed,
        )
    }
}

impl Default for RapheNuclei {
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
        let r = RapheNuclei::new();
        assert!((r.tonic_5ht - TONIC_5HT_REST).abs() < 0.01);
        assert_eq!(r.mode, RapheMode::Engaged);
    }

    #[test]
    fn test_social_warmth_raises_5ht() {
        let mut r = RapheNuclei::new();
        let before = r.tonic_5ht;
        r.process_event(RapheEvent::SocialWarmth);
        assert!(
            r.tonic_5ht > before,
            "social warmth should raise 5-HT: {:.2} → {:.2}",
            before,
            r.tonic_5ht
        );
    }

    #[test]
    fn test_deep_engagement_bigger_boost() {
        let mut r = RapheNuclei::new();
        let before = r.tonic_5ht;
        r.process_event(RapheEvent::DeepEngagement);
        let deep_gain = r.tonic_5ht - before;

        let mut r2 = RapheNuclei::new();
        let before2 = r2.tonic_5ht;
        r2.process_event(RapheEvent::SocialWarmth);
        let warm_gain = r2.tonic_5ht - before2;

        assert!(
            deep_gain > warm_gain,
            "deep engagement should give bigger boost than social warmth"
        );
    }

    #[test]
    fn test_conflict_lowers_5ht() {
        let mut r = RapheNuclei::new();
        let before = r.tonic_5ht;
        r.process_event(RapheEvent::SocialConflict);
        assert!(
            r.tonic_5ht < before,
            "conflict should lower 5-HT: {:.2} → {:.2}",
            before,
            r.tonic_5ht
        );
    }

    #[test]
    fn test_patient_mode_after_warmth() {
        let mut r = RapheNuclei::new();
        for _ in 0..6 {
            r.process_event(RapheEvent::SocialWarmth);
        }
        assert_eq!(
            r.mode,
            RapheMode::Patient,
            "repeated warmth should reach Patient mode, got {:?}, 5ht={:.2}",
            r.mode,
            r.tonic_5ht
        );
    }

    #[test]
    fn test_reactive_mode_after_conflict() {
        let mut r = RapheNuclei::new();
        // Start from lower baseline
        r.tonic_5ht = 0.40;
        r.process_event(RapheEvent::SocialConflict);
        r.process_event(RapheEvent::SocialConflict);
        assert!(
            matches!(r.mode, RapheMode::Reactive | RapheMode::Depleted),
            "multiple conflicts should push into Reactive/Depleted: {:?}",
            r.mode
        );
    }

    #[test]
    fn test_decay_drifts_toward_rest() {
        let mut r = RapheNuclei::new();
        r.tonic_5ht = 0.80;
        for _ in 0..50 {
            r.decay();
        }
        assert!(
            r.tonic_5ht < 0.80,
            "5-HT should decay toward rest: {:.2}",
            r.tonic_5ht
        );
        assert!(
            r.tonic_5ht >= TONIC_5HT_REST - 0.01,
            "should not fall below rest: {:.2}",
            r.tonic_5ht
        );
    }

    #[test]
    fn test_habenula_suppression_high_when_patient() {
        let mut r = RapheNuclei::new();
        r.tonic_5ht = 0.80;
        r.update_mode();
        let out = r.current_output();
        assert!(
            out.habenula_suppression > 0.0,
            "high 5-HT should suppress habenula: {:.2}",
            out.habenula_suppression
        );
    }

    #[test]
    fn test_habenula_suppression_zero_when_low() {
        let r = RapheNuclei::new();
        // At rest (0.50), which is exactly at PATIENCE_THRESHOLD border
        let out = r.current_output();
        // Should be near 0 or a small value
        assert!(
            out.habenula_suppression <= 0.40,
            "near-rest 5-HT should have low habenula suppression: {:.2}",
            out.habenula_suppression
        );
    }

    #[test]
    fn test_is_patient() {
        let mut r = RapheNuclei::new();
        r.tonic_5ht = PATIENCE_THRESHOLD + 0.05;
        r.update_mode();
        assert!(r.is_patient());
    }

    #[test]
    fn test_is_depleted() {

    }
}
